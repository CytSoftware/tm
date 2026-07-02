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
# Labels
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_columns(project: str | int) -> list[dict[str, Any]]:
    """List columns for a project, ordered left-to-right."""
    return await _async(tools.list_columns)(project=project)


@mcp.tool()
async def create_column(
    project: str | int,
    name: str,
    is_done: bool = False,
) -> dict[str, Any]:
    """Append a new column to ``project``.

    The new column lands at the rightmost position. Set ``is_done=True`` to
    mark it as a completion column (used by recurring-task defaults and
    analytics)."""
    return await _async(tools.create_column)(
        project=project, name=name, is_done=is_done
    )


@mcp.tool()
async def update_column(
    column_id: int,
    name: str | None = None,
    is_done: bool | None = None,
) -> dict[str, Any]:
    """Rename a column or toggle its ``is_done`` flag.

    Refuses to unmark the last ``is_done`` column in a project."""
    return await _async(tools.update_column)(
        column_id=column_id, name=name, is_done=is_done
    )


@mcp.tool()
async def delete_column(
    column_id: int,
    move_tasks_to: int | None = None,
) -> dict[str, Any]:
    """Delete a column. If it contains tasks, ``move_tasks_to`` is required
    and must reference another column in the same project."""
    return await _async(tools.delete_column)(
        column_id=column_id, move_tasks_to=move_tasks_to
    )


@mcp.tool()
async def reorder_columns(
    project: str | int, ordered_ids: list[int]
) -> list[dict[str, Any]]:
    """Set column order for a project. ``ordered_ids`` must list every
    column id in the project exactly once, left-to-right."""
    return await _async(tools.reorder_columns)(
        project=project, ordered_ids=ordered_ids
    )


@mcp.tool()
async def list_labels(project: str | int | None = None) -> list[dict[str, Any]]:
    """List labels. With ``project`` set, returns that project's labels plus
    global (project-less) labels. Without ``project``, returns every label."""
    return await _async(tools.list_labels)(project=project)


@mcp.tool()
async def create_label(
    name: str,
    color: str = "#888888",
    project: str | int | None = None,
) -> dict[str, Any]:
    """Create a label (or return the existing one with the same name+scope).

    ``color`` is a hex string like ``"#6366f1"``. Omit ``project`` to create a
    global label that's available across every project. If a label with this
    name already exists in the chosen scope, it is returned as-is — the call
    is idempotent on (project, name)."""
    return await _async(tools.create_label)(name=name, color=color, project=project)


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
# Personal focus list
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_focus() -> list[dict[str, Any]]:
    """List the calling user's personal focus items.

    Items are ordered Today → This week, then by manual position. Each entry
    embeds the underlying task (without description) so you can render it
    without a follow-up ``get_task`` call. Requires an authenticated MCP user
    — call this only from a session that's been issued an OAuth token, not
    from an anonymous Bearer token."""
    return await _async(tools.list_focus)(mcp_user=_get_mcp_user())


@mcp.tool()
async def add_focus(key: str, period: str = "week") -> dict[str, Any]:
    """Pin a task to the calling user's focus list.

    ``period`` accepts ``"day"`` (Today) or ``"week"`` (This week).
    Idempotent on (user, task) — calling again with a different ``period``
    moves the existing pin to that bucket and the bottom of its list."""
    return await _async(tools.add_focus)(
        key=key, period=period, mcp_user=_get_mcp_user()
    )


@mcp.tool()
async def remove_focus(key: str) -> dict[str, Any]:
    """Unpin a task from the calling user's focus list.

    Returns ``{"removed": True}`` when a pin was deleted, ``False`` when the
    task wasn't pinned in the first place."""
    return await _async(tools.remove_focus)(
        key=key, mcp_user=_get_mcp_user()
    )


# ---------------------------------------------------------------------------
# Pipelines
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_pipeline_stages() -> list[dict[str, Any]]:
    """List the kanban stages on the global pipelines board (in order)."""
    return await _async(tools.list_stages)()


@mcp.tool()
async def list_pipelines(
    stage: str | int | None = None,
    owner: str | None = None,
    search: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List pipelines.

    Pipelines are long-running processes (e.g. opening a bank account, vendor
    onboarding) tracked separately from tasks. ``stage`` accepts a stage id
    or name. ``owner`` accepts a username.
    """
    return await _async(tools.list_pipelines)(
        stage=stage, owner=owner, search=search, limit=limit
    )


@mcp.tool()
async def get_pipeline(key: str) -> dict[str, Any]:
    """Return a pipeline (with its full event timeline) for a key like ``"PIPE-001"``."""
    return await _async(tools.get_pipeline)(key)


@mcp.tool()
async def create_pipeline(
    title: str,
    description: str = "",
    counterparty: str = "",
    stage: str | int | None = None,
    owner: str | int | None = None,
) -> dict[str, Any]:
    """Create a new pipeline (a long-running tracked process).

    Omitting ``stage`` lands the pipeline in the first stage by order
    (typically ``"New"``). ``counterparty`` is the external party we're
    dealing with (bank name, vendor, etc.).
    """
    return await _async(tools.create_pipeline)(
        title=title,
        description=description,
        counterparty=counterparty,
        stage=stage,
        owner=owner,
        mcp_user=_get_mcp_user(),
    )


@mcp.tool()
async def update_pipeline(
    key: str,
    title: str | None = None,
    description: str | None = None,
    counterparty: str | None = None,
    owner: str | int | None = None,
) -> dict[str, Any]:
    """Update any subset of a pipeline's fields. Omitted fields are left alone."""
    return await _async(tools.update_pipeline)(
        key=key,
        title=title,
        description=description,
        counterparty=counterparty,
        owner=owner,
    )


@mcp.tool()
async def move_pipeline(
    key: str,
    stage: str | int,
    position: str | float | None = None,
) -> dict[str, Any]:
    """Move a pipeline to ``stage``.

    ``position`` accepts ``"top"``, ``"bottom"`` (default), or an explicit
    numeric value.
    """
    return await _async(tools.move_pipeline)(
        key=key, stage=stage, position=position
    )


@mcp.tool()
async def delete_pipeline(key: str) -> dict[str, Any]:
    """Delete a pipeline and its entire event history."""
    return await _async(tools.delete_pipeline)(key)


@mcp.tool()
async def log_pipeline_event(
    key: str,
    body: str,
) -> dict[str, Any]:
    """Append a timeline entry to a pipeline.

    Use this to record back-and-forth with a counterparty (e.g. "bank
    requested document A", "submitted form Y", "next: chase response by
    Friday").
    """
    return await _async(tools.log_pipeline_event)(
        key=key, body=body, mcp_user=_get_mcp_user()
    )


@mcp.tool()
async def list_pipeline_events(key: str) -> list[dict[str, Any]]:
    """Return the chronological event log for a pipeline."""
    return await _async(tools.list_pipeline_events)(key)


# ---------------------------------------------------------------------------
# CRM (contacts)
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_contact_labels() -> list[dict[str, Any]]:
    """List all contact labels (preset + user-created), alphabetically."""
    return await _async(tools.list_contact_labels)()


@mcp.tool()
async def list_contacts(
    search: str | None = None,
    country: str | None = None,
    city: str | None = None,
    industry: str | None = None,
    job_title: str | None = None,
    labels: list[str] | None = None,
    has_email: bool | None = None,
    has_phone: bool | None = None,
    has_linkedin: bool | None = None,
    has_website: bool | None = None,
    sort_field: str | None = None,
    sort_dir: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    """List contacts (CRM) with server-side filter / sort / pagination.

    All arguments are optional. ``country`` accepts an ISO-2 code or any
    common name (``"USA"``, ``"United States"``, ``"uk"``, …).
    ``industry`` (e.g. ``"Banking"``) and ``job_title`` (e.g. ``"CEO"``)
    use substring (icontains) match so variants and typos still hit.
    ``labels`` is a list of label names or ids — every selected label must
    be attached (intersection). ``sort_field`` accepts ``company``,
    ``first_name``, ``last_name``, ``email``, ``country``, ``city``,
    ``industry``, ``job_title``, ``created_at``, or ``updated_at``;
    ``sort_dir`` is ``asc`` (default) or ``desc``. Returns
    ``{"count": N, "results": [...]}``.
    """
    return await _async(tools.list_contacts)(
        search=search,
        country=country,
        city=city,
        industry=industry,
        job_title=job_title,
        labels=labels,
        has_email=has_email,
        has_phone=has_phone,
        has_linkedin=has_linkedin,
        has_website=has_website,
        sort_field=sort_field,
        sort_dir=sort_dir,
        limit=limit,
        offset=offset,
    )


@mcp.tool()
async def get_contact(key: str) -> dict[str, Any]:
    """Return a contact for a key like ``"CONT-0001"``."""
    return await _async(tools.get_contact)(key)


@mcp.tool()
async def create_contact(
    company: str = "",
    first_name: str = "",
    last_name: str = "",
    industry: str = "",
    job_title: str = "",
    email: str = "",
    phone: str = "",
    address_line1: str = "",
    address_line2: str = "",
    city: str = "",
    region: str = "",
    postal_code: str = "",
    country: str = "",
    websites: list[str] | None = None,
    linkedin: str = "",
    twitter: str = "",
    facebook: str = "",
    instagram: str = "",
    labels: list[str] | None = None,
    notes: str = "",
) -> dict[str, Any]:
    """Create a new contact.

    At least one of company / first_name / last_name / email should be
    provided — completely empty contacts are rejected. ``industry`` is the
    type of company (e.g. ``"Banking"``) and ``job_title`` is the person's
    role (e.g. ``"CEO"``). ``country`` accepts a 2-letter code or a
    free-text name (normalized to ISO-2). ``labels`` is a list of label
    names; unknown names auto-create the label.
    """
    return await _async(tools.create_contact)(
        company=company,
        first_name=first_name,
        last_name=last_name,
        industry=industry,
        job_title=job_title,
        email=email,
        phone=phone,
        address_line1=address_line1,
        address_line2=address_line2,
        city=city,
        region=region,
        postal_code=postal_code,
        country=country,
        websites=websites,
        linkedin=linkedin,
        twitter=twitter,
        facebook=facebook,
        instagram=instagram,
        labels=labels,
        notes=notes,
        mcp_user=_get_mcp_user(),
    )


@mcp.tool()
async def update_contact(
    key: str,
    company: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    industry: str | None = None,
    job_title: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    address_line1: str | None = None,
    address_line2: str | None = None,
    city: str | None = None,
    region: str | None = None,
    postal_code: str | None = None,
    country: str | None = None,
    websites: list[str] | None = None,
    linkedin: str | None = None,
    twitter: str | None = None,
    facebook: str | None = None,
    instagram: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    """Update any subset of a contact's fields. Omitted fields are left alone.

    To replace the whole websites list, pass the new list. To clear a
    social URL, pass an empty string. Labels are managed via the dedicated
    ``add_contact_label`` / ``remove_contact_label`` tools.
    """
    return await _async(tools.update_contact)(
        key=key,
        company=company,
        first_name=first_name,
        last_name=last_name,
        industry=industry,
        job_title=job_title,
        email=email,
        phone=phone,
        address_line1=address_line1,
        address_line2=address_line2,
        city=city,
        region=region,
        postal_code=postal_code,
        country=country,
        websites=websites,
        linkedin=linkedin,
        twitter=twitter,
        facebook=facebook,
        instagram=instagram,
        notes=notes,
    )


@mcp.tool()
async def delete_contact(key: str) -> dict[str, Any]:
    """Delete a contact by key. Returns ``{"deleted": True, "key": ...}``."""
    return await _async(tools.delete_contact)(key)


@mcp.tool()
async def add_contact_label(key: str, label: str) -> dict[str, Any]:
    """Attach ``label`` (by name) to a contact. Auto-creates the label if new."""
    return await _async(tools.add_contact_label)(key=key, label=label)


@mcp.tool()
async def remove_contact_label(key: str, label: str) -> dict[str, Any]:
    """Detach ``label`` (by name) from a contact. No-op if not attached."""
    return await _async(tools.remove_contact_label)(key=key, label=label)


# ---------------------------------------------------------------------------
# Wiki (docs)
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_wiki_docs(
    parent: str | int | None = None,
    project: str | int | None = None,
    search: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List wiki pages (the workspace knowledge base).

    Returns lightweight tree nodes (no body). ``parent`` accepts a doc key/id,
    or ``"root"`` for top-level pages only. ``project`` accepts a project
    key/id, or ``"none"`` for workspace-global pages only. ``search`` matches
    key / title / body text.
    """
    return await _async(tools.list_wiki_docs)(
        parent=parent, project=project, search=search, limit=limit
    )


@mcp.tool()
async def get_wiki_doc(key: str) -> dict[str, Any]:
    """Return a wiki page (with body content + plain text) for a key like ``"DOC-001"``."""
    return await _async(tools.get_wiki_doc)(key)


@mcp.tool()
async def create_wiki_doc(
    title: str = "Untitled",
    parent: str | int | None = None,
    project: str | int | None = None,
) -> dict[str, Any]:
    """Create a wiki page.

    ``parent`` (doc key/id) nests it under another page; omit for a top-level
    page. ``project`` (key/id) optionally links it to a project. The page body
    starts empty — write content with ``set_wiki_content`` /
    ``append_wiki_content`` / ``insert_wiki_content``.
    """
    return await _async(tools.create_wiki_doc)(
        title=title, parent=parent, project=project, mcp_user=_get_mcp_user()
    )


@mcp.tool()
async def update_wiki_doc(
    key: str,
    title: str | None = None,
    parent: str | int | None = None,
    project: str | int | None = None,
    clear_parent: bool = False,
    clear_project: bool = False,
) -> dict[str, Any]:
    """Update a wiki page's title / parent / project (NOT its body).

    Pass ``parent`` (key/id) to re-nest the page, or ``clear_parent=True`` to
    move it to the top level. Likewise ``project`` / ``clear_project``. Moving a
    page into its own subtree is rejected.
    """
    return await _async(tools.update_wiki_doc)(
        key=key,
        title=title,
        parent=parent,
        project=project,
        clear_parent=clear_parent,
        clear_project=clear_project,
    )


@mcp.tool()
async def delete_wiki_doc(key: str) -> dict[str, Any]:
    """Delete a wiki page and its entire subtree of child pages."""
    return await _async(tools.delete_wiki_doc)(key)


async def _wiki_apply(
    key: str, markdown: str, operation: str, index: int | None
) -> dict[str, Any]:
    """Apply a Markdown body write, then return the refreshed page.

    Runs the body write on daphne's event loop when invoked over the HTTP MCP
    transport (in-process), or routes it to daphne via the internal bridge when
    invoked from the stdio MCP process.
    """
    from apps.wiki import content_ops

    user = _get_mcp_user()
    user_id = user.id if user is not None else None

    bridge_url = os.environ.get("CYT_BROADCAST_URL")
    if bridge_url:
        await _async(content_ops.apply_content_via_bridge)(
            bridge_url,
            key,
            markdown=markdown,
            operation=operation,
            index=index,
            user_id=user_id,
        )
    else:
        await content_ops.apply_content(
            key,
            markdown=markdown,
            operation=operation,
            index=index,
            user_id=user_id,
        )
    return await _async(tools.get_wiki_doc)(key)


@mcp.tool()
async def set_wiki_content(key: str, markdown: str) -> dict[str, Any]:
    """Replace a wiki page's entire body with the given Markdown.

    Writes the page body (the collaborative document), reusing the editor's own
    encoder so the result is byte-identical to typing it in — open editors update
    live. Supports headings, **bold**/*italic*/`code`, links, bulleted &
    numbered lists, block quotes, fenced code blocks, GFM tables, and rules.
    Returns the refreshed page (incl. ``markdown``).
    """
    return await _wiki_apply(key, markdown, "replace", None)


@mcp.tool()
async def append_wiki_content(key: str, markdown: str) -> dict[str, Any]:
    """Append the given Markdown as new blocks at the end of a wiki page's body.

    Leaves existing content untouched. Same Markdown support as
    ``set_wiki_content``. Returns the refreshed page.
    """
    return await _wiki_apply(key, markdown, "append", None)


@mcp.tool()
async def insert_wiki_content(
    key: str, markdown: str, index: int
) -> dict[str, Any]:
    """Insert the given Markdown's blocks at top-level block position ``index``.

    ``index`` is 0-based over the page's top-level blocks: ``0`` inserts at the
    very top; a value at or beyond the block count appends at the end. Existing
    blocks shift down. Returns the refreshed page.
    """
    return await _wiki_apply(key, markdown, "insert", index)


# ---------------------------------------------------------------------------
# Drive (Backblaze B2 file storage)
# ---------------------------------------------------------------------------


@mcp.tool()
async def drive_list(prefix: str = "", token: str | None = None) -> dict[str, Any]:
    """List folders and files in the company Drive (Backblaze B2) under a prefix.

    ``prefix`` is a folder path like ``"docs/"`` (empty = bucket root). Returns
    ``{prefix, folders, files, next_token}``; pass ``next_token`` back to page
    through large folders. The internal ``llm-wiki/`` and trash prefixes are
    hidden.
    """
    return await _async(tools.drive_list)(prefix=prefix, token=token)


@mcp.tool()
async def drive_read(key: str, max_bytes: int = 65536) -> dict[str, Any]:
    """Return a Drive file's metadata plus a temporary download URL.

    ``key`` is the object key from ``drive_list`` (e.g. ``"docs/spec.pdf"``).
    Small UTF-8 text files are also returned inline as ``text``.
    """
    return await _async(tools.drive_read)(key=key, max_bytes=max_bytes)


@mcp.tool()
async def drive_upload(
    key: str,
    content: str = "",
    content_base64: str | None = None,
    content_type: str = "text/plain; charset=utf-8",
) -> dict[str, Any]:
    """Create or overwrite a Drive file with inline content.

    Provide text via ``content`` or binary via ``content_base64`` (exactly one).
    ``key`` is the destination path like ``"notes/todo.md"``. Deleting Drive
    files is intentionally not available over MCP.
    """
    return await _async(tools.drive_upload)(
        key=key, content=content, content_base64=content_base64,
        content_type=content_type, mcp_user=_get_mcp_user(),
    )


# ---------------------------------------------------------------------------
# Knowledge (LLM wiki — markdown pages under the llm-wiki/ prefix)
# ---------------------------------------------------------------------------


@mcp.tool()
async def knowledge_list() -> list[dict[str, Any]]:
    """List LLM-wiki pages (the agent-maintained markdown knowledge base).

    Returns ``[{slug, title, size, updated_at}, ...]``. Pages live in B2 under
    the ``llm-wiki/`` prefix, separate from the Drive.
    """
    return await _async(tools.knowledge_list)()


@mcp.tool()
async def knowledge_read(slug: str) -> dict[str, Any]:
    """Return one LLM-wiki page: ``{slug, title, markdown, meta, updated_at}``.

    ``slug`` may be nested, e.g. ``entities/people/ali-soukarieh``.
    """
    return await _async(tools.knowledge_read)(slug=slug)


@mcp.tool()
async def knowledge_sources() -> list[dict[str, Any]]:
    """List source documents already ingested into the LLM wiki.

    Returns ``[{source, etag, ingested_at, wiki_pages, ...}]`` from the ingest
    manifest. Diff this against ``drive_list("sources/")`` by ``etag`` to find
    documents that are new or changed and still need ingesting.
    """
    return await _async(tools.knowledge_sources)()


@mcp.tool()
async def knowledge_schema() -> dict[str, Any]:
    """The LLM-wiki conventions — CALL THIS FIRST before writing pages.

    Explains the directory taxonomy (entities/people, entities/companies,
    concepts, projects, decisions, sources), required YAML frontmatter,
    [[wikilink]] cross-references, and what the server auto-maintains.
    """
    return await _async(tools.knowledge_schema)()


@mcp.tool()
async def knowledge_write(slug: str, markdown: str) -> dict[str, Any]:
    """Create or update an LLM-wiki page (Markdown). FOLLOW THE STRUCTURE.

    Call ``knowledge_schema`` for the full rules. Key points:
    - The slug MUST be a directory path, not a bare name — e.g.
      ``entities/people/john-smith``, ``entities/companies/acme``,
      ``concepts/<name>``, ``projects/<name>``, ``sources/<name>``.
      Never write a page at the root.
    - Include YAML frontmatter (title, type, created, updated, tags).
    - Cross-reference other pages with ``[[path/to/page]]`` wikilinks.
    - If the page may already exist, ``knowledge_read`` it and update in place
      rather than duplicating.
    The ``index`` catalog and ``log`` are auto-maintained by the server on every
    write — do not create or edit them yourself.
    """
    return await _async(tools.knowledge_write)(
        slug=slug, markdown=markdown, mcp_user=_get_mcp_user(),
    )


@mcp.tool()
async def knowledge_delete(slug: str) -> dict[str, Any]:
    """Delete an LLM-wiki page by slug (e.g. ``entities/people/john-smith``).

    Irreversible. The activity ``log`` records the deletion and the ``index`` is
    regenerated automatically. The reserved ``index``/``log`` pages can't be deleted.
    """
    return await _async(tools.knowledge_delete)(slug=slug, mcp_user=_get_mcp_user())


@mcp.tool()
async def knowledge_reindex() -> dict[str, Any]:
    """Rebuild the ``index`` catalog from the current pages (housekeeping/repair)."""
    return await _async(tools.knowledge_reindex)()


# ---------------------------------------------------------------------------
# Entry point (stdio mode for Claude Desktop)
# ---------------------------------------------------------------------------


async def run_stdio() -> None:
    """Run the MCP server over stdio — the transport Claude Desktop uses."""
    await mcp.run_stdio_async()
