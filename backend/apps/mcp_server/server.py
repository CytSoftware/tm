"""MCP server exposing the task tracker over stdio and HTTP/SSE.

Uses the ``FastMCP`` high-level API from the ``mcp`` Python SDK. Each tool is
an async wrapper around a pure sync function in :mod:`apps.mcp_server.tools`,
bridged via ``sync_to_async`` so they work both in stdio mode (sync event loop)
and inside daphne's async ASGI server (the HTTP/SSE transport).

Two transports:
  - **stdio**: ``python manage.py mcp_serve`` (for Claude Desktop)
  - **HTTP/SSE**: mounted at ``/mcp/`` inside daphne (for remote agents)
"""

from __future__ import annotations

import os
from typing import Any

from asgiref.sync import sync_to_async
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from . import tools


def _get_mcp_user():
    """Return the OAuth-authenticated user for the current MCP request, or None."""
    from core.asgi import mcp_authenticated_user
    return mcp_authenticated_user.get(None)

# Disable the MCP SDK's built-in DNS rebinding protection entirely.
# We already authenticate via Bearer token (CYT_MCP_TOKEN) in our own
# ASGI middleware, so the SDK's Host/Origin validation is redundant and
# causes 421/403 rejections for legitimate remote clients.
mcp = FastMCP(
    "cyt-task-tracker",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ),
)


# Helper: wraps a sync tool function so it works in both sync and async contexts.
def _async(fn):
    return sync_to_async(fn, thread_sensitive=True)


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_projects() -> list[dict[str, Any]]:
    """List all projects in the task tracker."""
    return await _async(tools.list_projects)()


@mcp.tool()
async def list_tasks(
    project: str | int | None = None,
    assignee: str | None = None,
    priority: list[str] | None = None,
    labels: list[str] | None = None,
    column: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List tasks matching the given filters.

    Arguments are all optional. ``project`` accepts a prefix like ``"CYT"`` or
    a numeric id. ``assignee`` accepts a username (matches tasks where that
    user is one of the assignees). ``priority`` is a list like ``["P1", "P2"]``
    (P1 is highest). ``labels`` and ``column`` accept names.
    """
    return await _async(tools.list_tasks)(
        project=project,
        assignee=assignee,
        priority=priority,
        labels=labels,
        column=column,
        limit=limit,
    )


@mcp.tool()
async def get_task(key: str) -> dict[str, Any]:
    """Return the full task (including description) for a human key like ``"CYT-001"``."""
    return await _async(tools.get_task)(key)


@mcp.tool()
async def create_task(
    project: str | int,
    title: str,
    description: str = "",
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    labels: list[str] | None = None,
    story_points: int | None = None,
    column: str | int | None = None,
) -> dict[str, Any]:
    """Create a new task in ``project``.

    Omitting ``column`` places the task in the project's first non-done column
    (typically "Todo"). Omitting ``priority`` leaves the task without one (it
    sorts last in priority-desc order). ``assignees`` is a list of usernames or
    ids — a task can have zero or many assignees. Priority values when set:
    ``P1`` (highest), ``P2``, ``P3``, ``P4`` (lowest).
    """
    return await _async(tools.create_task)(
        project=project,
        title=title,
        description=description,
        assignees=assignees,
        priority=priority,
        labels=labels,
        story_points=story_points,
        column=column,
        mcp_user=_get_mcp_user(),
    )


@mcp.tool()
async def update_task(
    key: str,
    title: str | None = None,
    description: str | None = None,
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    labels: list[str] | None = None,
    story_points: int | None = None,
) -> dict[str, Any]:
    """Update any subset of a task's fields. Omitted fields are left unchanged.

    ``assignees`` replaces the full assignee list (pass an empty list to
    unassign everyone). Priority values: ``P1`` (highest) … ``P4`` (lowest).
    """
    return await _async(tools.update_task)(
        key=key,
        title=title,
        description=description,
        assignees=assignees,
        priority=priority,
        labels=labels,
        story_points=story_points,
    )


@mcp.tool()
async def move_task(
    key: str,
    column: str | int,
    position: str | float | None = None,
) -> dict[str, Any]:
    """Move a task to ``column``.

    ``position`` accepts ``"top"``, ``"bottom"`` (default), or an explicit
    numeric value.
    """
    return await _async(tools.move_task)(
        key=key, column=column, position=position, mcp_user=_get_mcp_user()
    )


@mcp.tool()
async def delete_task(key: str) -> dict[str, Any]:
    """Delete a task by its human key."""
    return await _async(tools.delete_task)(key)


@mcp.tool()
async def list_users() -> list[dict[str, Any]]:
    """List all active users (for assignee lookups)."""
    return await _async(tools.list_users)()


# ---------------------------------------------------------------------------
# Saved views
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_views(project: str | int | None = None) -> list[dict[str, Any]]:
    """List saved views, optionally scoped to a project."""
    return await _async(tools.list_views)(project=project)


@mcp.tool()
async def query_view(view: str | int) -> list[dict[str, Any]]:
    """Return the tasks matching a saved view's filters+sort.

    ``view`` can be the view's name or its numeric id.
    """
    return await _async(tools.query_view)(view)


# ---------------------------------------------------------------------------
# Recurring tasks
# ---------------------------------------------------------------------------


@mcp.tool()
async def create_recurring_task(
    project: str | int,
    title: str,
    schedule: str,
    dtstart: str | None = None,
    timezone_name: str = "UTC",
    description: str = "",
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    labels: list[str] | None = None,
    story_points: int | None = None,
    column: str | int | None = None,
) -> dict[str, Any]:
    """Create a recurring task template.

    ``schedule`` accepts human-friendly presets:

    - ``"daily"``                  → FREQ=DAILY
    - ``"weekdays"``               → FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
    - ``"weekly"``                 → FREQ=WEEKLY
    - ``"weekly:mon,wed,fri"``     → FREQ=WEEKLY;BYDAY=MO,WE,FR
    - ``"monthly"``                → FREQ=MONTHLY
    - ``"monthly:15"``             → FREQ=MONTHLY;BYMONTHDAY=15
    - ``"yearly"``                 → FREQ=YEARLY

    Any string containing ``FREQ=`` is treated as a raw RRULE and passed
    through after validation.
    """
    return await _async(tools.create_recurring_task)(
        project=project,
        title=title,
        schedule=schedule,
        dtstart=dtstart,
        timezone_name=timezone_name,
        description=description,
        assignees=assignees,
        priority=priority,
        labels=labels,
        story_points=story_points,
        column=column,
        mcp_user=_get_mcp_user(),
    )


@mcp.tool()
async def list_recurring_tasks(
    project: str | int | None = None, active: bool | None = None
) -> list[dict[str, Any]]:
    """List recurring templates, optionally filtered by project and active flag."""
    return await _async(tools.list_recurring_tasks)(project=project, active=active)


@mcp.tool()
async def update_recurring_task(
    id: int,
    title: str | None = None,
    description: str | None = None,
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    story_points: int | None = None,
    schedule: str | None = None,
    dtstart: str | None = None,
    column: str | int | None = None,
) -> dict[str, Any]:
    """Update any subset of a template's fields. Changing ``schedule`` or
    ``dtstart`` recomputes ``next_run_at``. ``assignees`` replaces the
    template's assignee list in full."""
    return await _async(tools.update_recurring_task)(
        id=id,
        title=title,
        description=description,
        assignees=assignees,
        priority=priority,
        story_points=story_points,
        schedule=schedule,
        dtstart=dtstart,
        column=column,
    )


@mcp.tool()
async def pause_recurring_task(id: int) -> dict[str, Any]:
    """Pause a recurring template so no new instances are generated."""
    return await _async(tools.pause_recurring_task)(id)


@mcp.tool()
async def resume_recurring_task(id: int) -> dict[str, Any]:
    """Resume a paused recurring template and recompute its next run time."""
    return await _async(tools.resume_recurring_task)(id)


@mcp.tool()
async def delete_recurring_task(id: int) -> dict[str, Any]:
    """Delete a recurring template. Existing generated tasks are preserved."""
    return await _async(tools.delete_recurring_task)(id)


@mcp.tool()
async def preview_recurring_task(id: int, count: int = 5) -> dict[str, Any]:
    """Return the next ``count`` scheduled occurrences without creating tasks."""
    return await _async(tools.preview_recurring_task)(id, count=count)


# ---------------------------------------------------------------------------
# Entry point (stdio mode for Claude Desktop)
# ---------------------------------------------------------------------------


async def run_stdio() -> None:
    """Run the MCP server over stdio — the transport Claude Desktop uses."""
    await mcp.run_stdio_async()
