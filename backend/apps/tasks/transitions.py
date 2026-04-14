"""Time-in-state helpers.

Two public surfaces:

* :func:`record_transition` — append a new row to the ``StateTransition`` log
  whenever a task changes column. Every write path (DRF viewset, MCP tools,
  recurring generator) calls this so the log stays authoritative.
* :func:`compute_staleness` / :func:`get_stale_thresholds` — derive the
  yellow/red badge from the currently-effective :class:`StaleThresholdConfig`.
  Thresholds are cached in-process for ~30s to avoid DB load on serializer
  hot paths; call :func:`invalidate_stale_thresholds` when the config is
  updated via the settings endpoint.

``current_column_since`` for a task is the ``at`` of the most recent
transition *into* the task's current column. Queryset annotation lives in
:func:`apps.tasks.query.base_task_queryset`.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from django.utils import timezone

from .models import (
    Column,
    StaleThresholdConfig,
    StateTransition,
    Task,
    TransitionSource,
)


# ---------------------------------------------------------------------------
# Writing transitions
# ---------------------------------------------------------------------------


def record_transition(
    task: Task,
    *,
    from_column: Column | None,
    to_column: Column | None,
    user=None,
    source: str = TransitionSource.USER,
    at: datetime | None = None,
) -> StateTransition:
    """Append one row to the state-transition log.

    Callers pass the old column explicitly — we don't infer it from
    ``task.column`` because by the time this is called the column has
    usually already been reassigned.
    """
    return StateTransition.objects.create(
        task=task,
        from_column=from_column,
        to_column=to_column,
        at=at or timezone.now(),
        triggered_by=user if (user is not None and getattr(user, "pk", None)) else None,
        source=source,
    )


# ---------------------------------------------------------------------------
# Threshold config cache (tiny, read-mostly)
# ---------------------------------------------------------------------------

_CACHE: dict[str, Any] = {"value": None, "until": 0.0}
_CACHE_TTL_SECONDS = 30.0


def get_stale_thresholds() -> dict[str, dict[str, int]]:
    """Return the currently-effective threshold map.

    Cached in-process for ~30s so per-task serialization doesn't hit the DB
    on every request. Invalidate explicitly on writes via
    :func:`invalidate_stale_thresholds`.
    """
    now = time.monotonic()
    if _CACHE["value"] is not None and _CACHE["until"] > now:
        return _CACHE["value"]
    config = StaleThresholdConfig.load()
    _CACHE["value"] = config.thresholds or {}
    _CACHE["until"] = now + _CACHE_TTL_SECONDS
    return _CACHE["value"]


def invalidate_stale_thresholds() -> None:
    _CACHE["value"] = None
    _CACHE["until"] = 0.0


# ---------------------------------------------------------------------------
# Staleness computation
# ---------------------------------------------------------------------------


def compute_staleness(
    task: Task,
    *,
    now: datetime | None = None,
    thresholds: dict[str, dict[str, int]] | None = None,
) -> str | None:
    """Return ``"red"``, ``"yellow"``, or ``None`` for the task.

    Reads ``task.current_column_since`` if the queryset annotation is present
    (see :func:`apps.tasks.query.base_task_queryset`). Falls back to a DB
    lookup otherwise — used by the MCP tools which share the same queryset.
    """
    column = getattr(task, "column", None)
    if column is None or column.is_done:
        return None

    thresholds = thresholds if thresholds is not None else get_stale_thresholds()
    rules = thresholds.get(column.name)
    if not rules:
        return None

    since = getattr(task, "current_column_since", None)
    if since is None:
        since = _lookup_current_column_since(task)
    if since is None:
        return None

    now = now or timezone.now()
    days = (now - since).total_seconds() / 86400.0

    red = rules.get("red_days")
    yellow = rules.get("yellow_days")
    if red is not None and days >= red:
        return "red"
    if yellow is not None and days >= yellow:
        return "yellow"
    return None


def _lookup_current_column_since(task: Task) -> datetime | None:
    if not task.column_id:
        return None
    t = (
        StateTransition.objects.filter(
            task_id=task.id, to_column_id=task.column_id
        )
        .order_by("-at")
        .values_list("at", flat=True)
        .first()
    )
    return t
