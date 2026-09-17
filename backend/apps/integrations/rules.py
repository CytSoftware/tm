"""GitHub PR review-lifecycle rule engine (TAS-011).

The P0 webhook (``services.apply_pull_request_event``) only upserts
``TaskPullRequest`` rows — it never moves tasks between columns. This module
is the P1 rule engine that plugs in after the upsert step:

* ``review_requested`` → move the linked task(s) to the project's ``REVIEW``
  kind column and track the requested reviewer.
* Merged into ``dev`` → the conventionally named ``In Dev`` column, if present.
* Merged into ``main`` → ``DONE``. Approval alone never completes a task.
* ``changes_requested`` → move back to the ``IN_PROGRESS`` kind column.

Every public entry point (the ``apply_*`` functions) is wrapped so it never
raises — a malformed or unexpected payload shape must not 500 the webhook,
mirroring the fire-and-forget contract of ``broadcast_task_event`` /
``notify_task_event``.
"""

from __future__ import annotations

import logging
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Max

from apps.tasks.broadcast import broadcast_task_event
from apps.tasks.models import Column, ColumnKind, Task, TransitionEvent, TransitionSource
from apps.tasks.notifications import notify_task_event
from apps.tasks.transitions import record_transition

from .models import TaskPullRequest

logger = logging.getLogger(__name__)

User = get_user_model()


# ---------------------------------------------------------------------------
# Pure decision functions
# ---------------------------------------------------------------------------


def target_kind_for_pr_action(action: str, pr: dict[str, Any]) -> str | None:
    """Resolve standard stages; named In Dev is handled by the merge rule."""
    if pr.get("merged") is True and (pr.get("base") or {}).get("ref") == "main":
        return ColumnKind.DONE
    if action == "review_requested":
        return ColumnKind.REVIEW
    return None


def target_kind_for_review_state(state: str) -> str | None:
    """Return the ``ColumnKind`` a ``pull_request_review`` state maps to."""
    if state == "changes_requested":
        return ColumnKind.IN_PROGRESS
    return None


# ---------------------------------------------------------------------------
# Reviewer resolution
# ---------------------------------------------------------------------------


def find_user_by_github_login(login: str):
    """Resolve a GitHub login to a ``User`` via ``UserProfile.github_username``.

    Case-insensitive. Returns ``None`` when unmapped. Warns (does not raise)
    if more than one active user shares the same ``github_username`` — v1 has
    no uniqueness constraint, so this is a data-hygiene signal, not an error.
    """
    if not login:
        return None
    matches = list(
        User.objects.filter(profile__github_username__iexact=login, is_active=True)[:2]
    )
    if not matches:
        return None
    if len(matches) > 1:
        logger.warning(
            "github rules: multiple active users map to github_username=%r; using %s",
            login,
            matches[0].username,
        )
    return matches[0]


def set_reviewer(tpr: TaskPullRequest, task: Task, login: str) -> None:
    """Set ``tpr.reviewer_login`` and ``task.reviewer`` for ``login``.

    ``task.reviewer`` is left null when the login has no mapped user — the
    login itself is still visible via ``tpr.reviewer_login``.
    """
    tpr.reviewer_login = login[:200]
    tpr.save(update_fields=["reviewer_login"])
    task.reviewer = find_user_by_github_login(login)
    task.save(update_fields=["reviewer", "updated_at"])


def clear_reviewer_if_matches(tpr: TaskPullRequest, task: Task, login: str) -> None:
    """Clear the reviewer on ``review_request_removed``, if it still matches.

    Guards against a stale "remove" event clobbering a reviewer set by a
    later, different request (per the v1 accepted edge: two open review
    requests on one task, latest event wins).
    """
    if tpr.reviewer_login and tpr.reviewer_login.lower() != login.lower():
        return
    tpr.reviewer_login = ""
    tpr.save(update_fields=["reviewer_login"])
    task.reviewer = None
    task.save(update_fields=["reviewer", "updated_at"])


# ---------------------------------------------------------------------------
# Column move executor
# ---------------------------------------------------------------------------


def move_task_to_column_kind(task: Task, kind: str) -> bool:
    """Move ``task`` to its project's column of the given ``kind``.

    Returns ``True`` if a move happened, ``False`` for every no-op case
    (missing project, no column of that kind on the project, or the task is
    already there). Mirrors the canonical move trio used by
    ``TaskViewSet.move`` — atomic column+position update, a transition-log
    row, then broadcast + notify.
    """
    if not task.project_id:
        return False

    columns = Column.objects.filter(project_id=task.project_id, kind=kind).order_by("order")
    if kind == ColumnKind.REVIEW:
        columns = columns.exclude(name__iexact="In Dev")
        column = columns.filter(name__iexact="In Review").first() or columns.first()
    else:
        column = columns.first()
    if column is None:
        logger.info(
            "github rules: project %s has no %r column, skipping move for %s",
            task.project_id,
            kind,
            task.key,
        )
        return False

    return move_task_to_column(task, column)


def move_task_to_column(task: Task, column: Column) -> bool:
    with transaction.atomic():
        task = Task.objects.select_for_update().get(pk=task.pk)
        old_column = task.column
        # GitHub events must not resurrect cancelled/completed work or undo a
        # dev merge when a release PR requests review of the same task.
        if old_column and (
            old_column.id == column.id
            or old_column.kind in (ColumnKind.DONE, ColumnKind.CANCELLED, ColumnKind.OTHER)
            or (old_column.name.casefold() == "in dev" and not column.is_done)
        ):
            return False
        task.column = column
        task.position = _next_bottom_position(column)
        task.save(update_fields=["column", "position", "updated_at"])
        record_transition(
            task,
            from_column=old_column,
            to_column=column,
            event_type=TransitionEvent.MOVED,
            user=None,
            source=TransitionSource.GITHUB,
        )

    def publish():
        broadcast_task_event(
            task.project_id, "task.moved",
            {"key": task.key, "id": task.id, "column_id": column.id},
        )
        notify_task_event(
            task, None, "completed" if column.is_done else "moved",
            payload={"from_column": old_column.name if old_column else None, "to_column": column.name},
        )

    transaction.on_commit(publish)
    return True


def _next_bottom_position(column: Column) -> float:
    current_max = column.tasks.all().aggregate(m=Max("position"))["m"]
    return (current_max or 0) + 1000.0


# ---------------------------------------------------------------------------
# Public entry points — never raise
# ---------------------------------------------------------------------------


def apply_pr_action_rules(
    task: Task, tpr: TaskPullRequest, action: str, payload: dict[str, Any]
) -> bool:
    """Apply the ``pull_request`` event rules for one linked task.

    Handles reviewer bookkeeping (``review_requested`` /
    ``review_request_removed``) and the corresponding column move. Returns
    ``True`` if the task moved columns.
    """
    try:
        return _apply_pr_action_rules(task, tpr, action, payload)
    except Exception:  # pragma: no cover - defensive, mirrors broadcast_task_event
        logger.exception(
            "apply_pr_action_rules failed (task=%s action=%s)",
            getattr(task, "key", None),
            action,
        )
        return False


def _apply_pr_action_rules(
    task: Task, tpr: TaskPullRequest, action: str, payload: dict[str, Any]
) -> bool:
    pr = payload.get("pull_request") or {}

    if action == "review_requested":
        login = ((payload.get("requested_reviewer") or {}).get("login")) or ""
        # Team review requests (payload carries requested_team instead) have
        # no individual login to track — the move still happens below.
        if login:
            set_reviewer(tpr, task, login)
    elif action == "review_request_removed":
        login = ((payload.get("requested_reviewer") or {}).get("login")) or ""
        if login:
            clear_reviewer_if_matches(tpr, task, login)
        return False

    if tpr.merged:
        if tpr.base_ref == "main" or payload.get("_promoted_to_main"):
            return move_task_to_column_kind(task, ColumnKind.DONE)
        if tpr.base_ref == "dev":
            columns = list(Column.objects.filter(project_id=task.project_id, name__iexact="In Dev")[:2])
            if len(columns) == 1:
                return move_task_to_column(task, columns[0])
        return False
    if tpr.state != "open":
        return False

    kind = target_kind_for_pr_action(action, pr)
    if kind is None:
        return False
    return move_task_to_column_kind(task, kind)


def apply_review_rules(task: Task, tpr: TaskPullRequest, review: dict[str, Any]) -> bool:
    """Apply the ``pull_request_review`` (``submitted``) rules for one task.

    Sets ``task.reviewer`` from the actual reviewing user (wins over any
    earlier requested-reviewer login), then moves the task per
    ``target_kind_for_review_state``. ``Task.reviewer`` is intentionally left
    set after a move to Done — it doubles as "reviewed by X" provenance.
    """
    try:
        return _apply_review_rules(task, tpr, review)
    except Exception:  # pragma: no cover - defensive, mirrors broadcast_task_event
        logger.exception(
            "apply_review_rules failed (task=%s state=%s)",
            getattr(task, "key", None),
            review.get("state"),
        )
        return False


def _apply_review_rules(task: Task, tpr: TaskPullRequest, review: dict[str, Any]) -> bool:
    state = (review.get("state") or "").lower()
    if state not in ("approved", "changes_requested"):
        return False

    login = ((review.get("user") or {}).get("login")) or ""
    if login:
        set_reviewer(tpr, task, login)

    kind = target_kind_for_review_state(state)
    if kind is None:
        return False

    if tpr.merged or tpr.state != "open":
        return False

    return move_task_to_column_kind(task, kind)
