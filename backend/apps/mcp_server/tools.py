"""Pure-Python MCP tool implementations.

These functions are the canonical logic that the ``apps.mcp_server.server``
module wraps with ``@mcp.tool()`` decorators. Keeping the logic in plain
functions means:

* We can unit-test them without the MCP transport loop.
* They share filter / sort code with DRF via :mod:`apps.tasks.query`.
* Each write path runs inside ``transaction.atomic`` and calls
  ``broadcast_task_event`` — so LLM-driven changes reach connected browsers
  live via the same Channels groups the DRF viewset publishes to.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F, Max, Q
from django.utils import timezone

from apps.tasks.broadcast import broadcast_task_event
from apps.tasks.models import (
    Bet,
    BetStatus,
    Checkin,
    Column,
    Label,
    Metric,
    Priority,
    Project,
    RecurringTaskTemplate,
    Task,
    TransitionSource,
    View,
)
from apps.tasks.notifications import notify_task_event
from apps.tasks.periods import (
    current_period_start,
    period_end,
    period_label,
    period_start_for,
)
from apps.tasks.query import (
    base_task_queryset,
    filter_and_sort_tasks,
)
from apps.tasks.recurring import (
    compute_initial_next_run,
    parse_schedule,
    preview_occurrences,
    validate_rrule,
)
from apps.tasks.transitions import record_transition

User = get_user_model()


# ---------------------------------------------------------------------------
# Identifier resolution
# ---------------------------------------------------------------------------
#
# MCP tools accept human-friendly identifiers: a project can be looked up by
# prefix ("CYT") or id; a user by username or id; a label by name. These
# helpers centralize that resolution so each tool stays terse.


def _resolve_project(ref: str | int) -> Project:
    if isinstance(ref, int):
        return Project.objects.get(pk=ref)
    if isinstance(ref, str):
        if ref.isdigit():
            return Project.objects.get(pk=int(ref))
        return Project.objects.get(prefix__iexact=ref)
    raise ValueError(f"Invalid project reference: {ref!r}")


def _resolve_user(ref: str | int | None) -> Any:
    if ref is None:
        return None
    if isinstance(ref, int):
        return User.objects.get(pk=ref)
    if isinstance(ref, str):
        if ref.isdigit():
            return User.objects.get(pk=int(ref))
        return User.objects.get(username=ref)
    raise ValueError(f"Invalid user reference: {ref!r}")


def _resolve_column(project: Project, ref: str | int | None) -> Column:
    if ref is None:
        col = (
            project.columns.filter(is_done=False).order_by("order").first()
            or project.columns.order_by("order").first()
        )
        if col is None:
            raise ValueError(f"Project {project.prefix} has no columns.")
        return col
    if isinstance(ref, int):
        return project.columns.get(pk=ref)
    if isinstance(ref, str):
        if ref.isdigit():
            return project.columns.get(pk=int(ref))
        return project.columns.get(name__iexact=ref)
    raise ValueError(f"Invalid column reference: {ref!r}")


def _resolve_labels(project: Project, refs: Iterable[str | int]) -> list[Label]:
    # Labels can either be project-scoped or global (project_id is null). Match
    # both — project-scoped first, then global — so MCP callers can mix the two
    # in a single labels=[...] argument.
    candidate_qs = Label.objects.filter(Q(project=project) | Q(project__isnull=True))
    labels: list[Label] = []
    for ref in refs:
        if isinstance(ref, int):
            labels.append(candidate_qs.get(pk=ref))
        elif isinstance(ref, str):
            if ref.isdigit():
                labels.append(candidate_qs.get(pk=int(ref)))
            else:
                # Prefer a project-scoped label by name; fall back to a global one.
                match = (
                    candidate_qs.filter(name__iexact=ref)
                    .order_by(F("project_id").asc(nulls_last=True))
                    .first()
                )
                if match is None:
                    raise Label.DoesNotExist(
                        f"No label named {ref!r} in project {project.prefix} or globally."
                    )
                labels.append(match)
        else:
            raise ValueError(f"Invalid label reference: {ref!r}")
    return labels


def _normalize_priority(priority: str | None) -> str | None:
    if priority is None:
        return None
    priority = priority.upper()
    if priority not in Priority.values:
        raise ValueError(
            f"Unknown priority {priority!r}. Use one of: {', '.join(Priority.values)}."
        )
    return priority


# ---------------------------------------------------------------------------
# Serialization (plain dicts for MCP JSON transport)
# ---------------------------------------------------------------------------


def _project_dict(p: Project) -> dict[str, Any]:
    return {
        "id": p.id,
        "name": p.name,
        "prefix": p.prefix,
        "description": p.description,
        "color": p.color,
        "icon": p.icon,
        "archived": p.archived,
        "task_counter": p.task_counter,
    }


def _column_dict(c: Column) -> dict[str, Any]:
    return {
        "id": c.id,
        "project_id": c.project_id,
        "name": c.name,
        "order": c.order,
        "is_done": c.is_done,
    }


def _label_dict(label: Label) -> dict[str, Any]:
    return {
        "id": label.id,
        "name": label.name,
        "color": label.color,
        "project_id": label.project_id,
    }


def _user_dict(u) -> dict[str, Any] | None:
    if u is None:
        return None
    return {"id": u.id, "username": u.username, "email": u.email}


def _task_dict(t: Task, *, include_description: bool = True) -> dict[str, Any]:
    from apps.tasks.transitions import compute_staleness

    since = getattr(t, "current_column_since", None)
    data = {
        "id": t.id,
        "key": t.key,
        "title": t.title,
        "project": t.project.prefix if t.project_id else None,
        "column": t.column.name if t.column_id else None,
        "column_id": t.column_id,
        "priority": t.priority,
        "story_points": t.story_points,
        "assignees": [u.username for u in t.assignees.all()],
        "labels": [label.name for label in t.labels.all()],
        "bet": t.bet.name if t.bet_id else None,
        "bet_id": t.bet_id,
        "position": t.position,
        "due_at": t.due_at.isoformat() if t.due_at else None,
        "created_at": t.created_at.isoformat(),
        "updated_at": t.updated_at.isoformat(),
        "recurrence_template_id": t.recurrence_template_id,
        "current_column_since": since.isoformat() if since else None,
        "staleness": compute_staleness(t),
        "linked_prs": [_linked_pr_dict(link) for link in t.pull_requests.all()],
    }
    if include_description:
        data["description"] = t.description
    return data


def _linked_pr_dict(link) -> dict[str, Any]:
    return {
        "pr_number": link.pr_number,
        "pr_title": link.pr_title,
        "state": link.state,
        "merged": link.merged,
        "is_draft": link.is_draft,
        "head_ref": link.head_ref,
        "base_ref": link.base_ref,
        "html_url": link.html_url,
        "author_login": link.author_login,
        "repository": (
            link.repository.repo_full_name if link.repository_id else None
        ),
        "opened_at": link.opened_at.isoformat() if link.opened_at else None,
        "merged_at": link.merged_at.isoformat() if link.merged_at else None,
        "closed_at": link.closed_at.isoformat() if link.closed_at else None,
    }


def _template_dict(tpl: RecurringTaskTemplate) -> dict[str, Any]:
    return {
        "id": tpl.id,
        "project": tpl.project.prefix,
        "title": tpl.title,
        "description": tpl.description,
        "assignees": [u.username for u in tpl.assignees.all()],
        "labels": [label.name for label in tpl.labels.all()],
        "priority": tpl.priority,
        "story_points": tpl.story_points,
        "column": tpl.column.name if tpl.column_id else None,
        "rrule": tpl.rrule,
        "dtstart": tpl.dtstart.isoformat(),
        "timezone": tpl.timezone,
        "next_run_at": tpl.next_run_at.isoformat(),
        "last_generated_at": tpl.last_generated_at.isoformat()
        if tpl.last_generated_at
        else None,
        "active": tpl.active,
        "created_by": tpl.created_by.username if tpl.created_by_id else None,
        "created_at": tpl.created_at.isoformat(),
        "updated_at": tpl.updated_at.isoformat(),
    }


def _view_dict(v: View) -> dict[str, Any]:
    return {
        "id": v.id,
        "name": v.name,
        "owner": v.owner.username,
        "project": v.project.prefix if v.project_id else None,
        "kind": v.kind,
        "filters": v.filters,
        "sort": v.sort,
        "shared": v.shared,
    }


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


def list_projects() -> list[dict[str, Any]]:
    return [_project_dict(p) for p in Project.objects.all().order_by("name")]


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------


def list_columns(project: str | int) -> list[dict[str, Any]]:
    proj = _resolve_project(project)
    return [_column_dict(c) for c in proj.columns.order_by("order")]


@transaction.atomic
def create_column(
    project: str | int,
    name: str,
    is_done: bool = False,
) -> dict[str, Any]:
    proj = _resolve_project(project)
    name = (name or "").strip()
    if not name:
        raise ValueError("Column name must not be empty.")
    next_order = (proj.columns.aggregate(m=Max("order"))["m"] or -1) + 1
    column = Column.objects.create(
        project=proj, name=name, order=next_order, is_done=is_done
    )
    broadcast_task_event(
        proj.id, "column.created", {"column": _column_dict(column)}
    )
    return _column_dict(column)


@transaction.atomic
def update_column(
    column_id: int,
    name: str | None = None,
    is_done: bool | None = None,
) -> dict[str, Any]:
    column = Column.objects.select_for_update().get(pk=column_id)
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("Column name must not be empty.")
        column.name = name
    if is_done is not None:
        if column.is_done and not is_done:
            others = (
                column.project.columns.filter(is_done=True)
                .exclude(pk=column.pk)
                .exists()
            )
            if not others:
                raise ValueError(
                    "At least one column must be marked as done."
                )
        column.is_done = is_done
    column.save()
    broadcast_task_event(
        column.project_id, "column.updated", {"column": _column_dict(column)}
    )
    return _column_dict(column)


@transaction.atomic
def delete_column(
    column_id: int,
    move_tasks_to: int | None = None,
) -> dict[str, Any]:
    column = Column.objects.select_for_update().get(pk=column_id)
    project = column.project
    has_tasks = column.tasks.exists()
    target: Column | None = None
    if move_tasks_to is not None:
        target = project.columns.exclude(pk=column.pk).get(pk=move_tasks_to)
    if has_tasks and target is None:
        raise ValueError(
            "Column has tasks. Pass move_tasks_to=<column_id> to relocate "
            "them before deletion."
        )
    if column.is_done and not (
        project.columns.filter(is_done=True).exclude(pk=column.pk).exists()
    ):
        raise ValueError(
            "Cannot delete the last column marked as done. Mark another "
            "column as done first."
        )
    if target is not None:
        next_pos = (target.tasks.aggregate(m=Max("position"))["m"] or 0) + 1000.0
        for task in column.tasks.order_by("position"):
            task.column = target
            task.position = next_pos
            task.save(update_fields=["column", "position", "updated_at"])
            next_pos += 1000.0
    deleted_id = column.id
    column.delete()
    broadcast_task_event(project.id, "column.deleted", {"column_id": deleted_id})
    return {"id": deleted_id, "deleted": True}


@transaction.atomic
def reorder_columns(
    project: str | int, ordered_ids: list[int]
) -> list[dict[str, Any]]:
    proj = _resolve_project(project)
    existing = list(proj.columns.select_for_update().order_by("order"))
    existing_ids = {c.id for c in existing}
    ordered_ids_int = [int(x) for x in ordered_ids]
    if set(ordered_ids_int) != existing_ids or len(ordered_ids_int) != len(existing):
        raise ValueError(
            "ordered_ids must list every column in the project exactly once."
        )
    offset = (max(c.order for c in existing) if existing else 0) + 1000
    for c in existing:
        Column.objects.filter(pk=c.pk).update(order=c.order + offset)
    for new_index, cid in enumerate(ordered_ids_int):
        Column.objects.filter(pk=cid).update(order=new_index)
    refreshed = list(proj.columns.order_by("order"))
    broadcast_task_event(
        proj.id,
        "column.reordered",
        {"columns": [_column_dict(c) for c in refreshed]},
    )
    return [_column_dict(c) for c in refreshed]


def list_tasks(
    project: str | int | None = None,
    assignee: str | None = None,
    priority: list[str] | None = None,
    labels: list[str] | None = None,
    column: str | None = None,
    bet: str | int | None = None,
    done: bool | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {}
    if project is not None:
        filters["project"] = project
    if assignee:
        filters["assignee"] = [assignee]
    if priority:
        filters["priority"] = priority
    if labels:
        filters["labels"] = labels
    if column:
        filters["column"] = column
    if bet is not None:
        filters["bet"] = bet
    if done is not None:
        filters["done"] = done
    qs = filter_and_sort_tasks(filters=filters)
    return [_task_dict(t, include_description=False) for t in qs[:limit]]


def get_task(key: str) -> dict[str, Any]:
    t = base_task_queryset().get(key=key)
    return _task_dict(t)


@transaction.atomic
def create_task(
    project: str | int,
    title: str,
    description: str = "",
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    labels: list[str | int] | None = None,
    story_points: int | None = None,
    column: str | int | None = None,
    bet: str | int | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    proj = _resolve_project(project)
    col = _resolve_column(proj, column)
    assignee_users = [_resolve_user(ref) for ref in assignees] if assignees else []
    reporter = _resolve_reporter_for_mcp(mcp_user)

    task = Task(
        project=proj,
        column=col,
        title=title,
        description=description or "",
        priority=_normalize_priority(priority),
        story_points=story_points,
        reporter=reporter,
        bet=_resolve_bet(bet, project=proj) if bet is not None else None,
        position=_next_bottom_position(col),
    )
    task.save()
    if labels:
        task.labels.set(_resolve_labels(proj, labels))
    if assignee_users:
        task.assignees.set(assignee_users)

    record_transition(
        task,
        from_column=None,
        to_column=col,
        user=mcp_user,
        source=TransitionSource.MCP,
    )

    broadcast_task_event(
        proj.id, "task.created", {"key": task.key, "id": task.id}
    )
    notify_task_event(task, mcp_user, "assigned")
    # "created" is webhook-only (recipients=[]) — fires alongside "assigned"
    # above when the task is created with assignees; intentional, not deduped.
    notify_task_event(task, mcp_user, "created", recipients=[])
    return _task_dict(task)


@transaction.atomic
def update_task(
    key: str,
    title: str | None = None,
    description: str | None = None,
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    labels: list[str | int] | None = None,
    story_points: int | None = None,
    bet: str | int | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    task = base_task_queryset().get(key=key)
    dirty = False

    old_assignee_ids = set(task.assignees.values_list("id", flat=True))
    old_label_ids = set(task.labels.values_list("id", flat=True))
    old_values = {
        f: getattr(task, f) for f in ("title", "description", "priority", "story_points")
    }

    if title is not None:
        task.title = title
        dirty = True
    if description is not None:
        task.description = description
        dirty = True
    if priority is not None:
        task.priority = _normalize_priority(priority) or task.priority
        dirty = True
    if story_points is not None:
        task.story_points = story_points
        dirty = True
    if bet is not None:
        # ``"none"`` unlinks; anything else resolves within the task's project.
        if bet == "none":
            task.bet = None
        else:
            if task.project_id is None:
                raise ValueError("Projectless tasks cannot link to a bet.")
            task.bet = _resolve_bet(bet, project=task.project)
        dirty = True

    if dirty:
        task.save()
    if labels is not None:
        task.labels.set(_resolve_labels(task.project, labels))
    if assignees is not None:
        task.assignees.set([_resolve_user(ref) for ref in assignees])

    broadcast_task_event(
        task.project_id, "task.updated", {"key": task.key, "id": task.id}
    )

    new_assignee_ids = set(task.assignees.values_list("id", flat=True))
    newly_added_ids = new_assignee_ids - old_assignee_ids
    still_assigned_ids = new_assignee_ids & old_assignee_ids

    if newly_added_ids:
        notify_task_event(
            task,
            mcp_user,
            "assigned",
            recipients=User.objects.filter(id__in=newly_added_ids),
        )

    changed_fields = [f for f in old_values if old_values[f] != getattr(task, f)]
    new_label_ids = set(task.labels.values_list("id", flat=True))
    if new_label_ids != old_label_ids:
        changed_fields.append("labels")

    if changed_fields:
        notify_task_event(
            task,
            mcp_user,
            "updated",
            recipients=User.objects.filter(id__in=still_assigned_ids),
            payload={"changed_fields": changed_fields},
        )

    return _task_dict(task)


@transaction.atomic
def move_task(
    key: str,
    column: str | int,
    position: str | float | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    task = base_task_queryset().get(key=key)
    old_column = task.column
    col = _resolve_column(task.project, column)
    task.column = col

    if position is None or position == "bottom":
        task.position = _next_bottom_position(col, exclude_task_id=task.id)
    elif position == "top":
        task.position = _next_top_position(col, exclude_task_id=task.id)
    else:
        try:
            task.position = float(position)
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"position must be 'top', 'bottom', or a number — got {position!r}"
            ) from e

    task.save(update_fields=["column", "position", "updated_at"])
    column_changed = (old_column.id if old_column else None) != col.id
    if column_changed:
        record_transition(
            task,
            from_column=old_column,
            to_column=col,
            user=mcp_user,
            source=TransitionSource.MCP,
        )
    broadcast_task_event(
        task.project_id,
        "task.moved",
        {"key": task.key, "id": task.id, "column_id": col.id},
    )
    if column_changed:
        verb = "completed" if col.is_done else "moved"
        notify_task_event(
            task,
            mcp_user,
            verb,
            payload={
                "from_column": old_column.name if old_column else None,
                "to_column": col.name,
            },
        )
    return _task_dict(task)


@transaction.atomic
def delete_task(key: str, mcp_user=None) -> dict[str, Any]:
    task = base_task_queryset().get(key=key)
    project_id = task.project_id
    task_key = task.key
    notify_task_event(task, mcp_user, "deleted")
    task.delete()
    broadcast_task_event(project_id, "task.deleted", {"key": task_key})
    return {"ok": True, "key": task_key}


def _next_bottom_position(column: Column, *, exclude_task_id: int | None = None) -> float:
    qs = column.tasks.all()
    if exclude_task_id is not None:
        qs = qs.exclude(id=exclude_task_id)
    current_max = qs.aggregate(m=Max("position"))["m"]
    return (current_max or 0) + 1000.0


def _next_top_position(column: Column, *, exclude_task_id: int | None = None) -> float:
    qs = column.tasks.all()
    if exclude_task_id is not None:
        qs = qs.exclude(id=exclude_task_id)
    current_min = qs.order_by("position").first()
    if current_min is None:
        return 1000.0
    return current_min.position - 1000.0


def list_users() -> list[dict[str, Any]]:
    return [
        {"id": u.id, "username": u.username, "email": u.email}
        for u in User.objects.filter(is_active=True).order_by("username")
    ]


# ---------------------------------------------------------------------------
# Personal focus list
# ---------------------------------------------------------------------------


def _focus_dict(item) -> dict[str, Any]:
    return {
        "id": item.id,
        "task": _task_dict(item.task, include_description=False),
        "period": item.period,
        "position": item.position,
        "created_at": item.created_at.isoformat(),
        "updated_at": item.updated_at.isoformat(),
    }


def list_focus(*, mcp_user) -> list[dict[str, Any]]:
    """List the calling user's personal focus items, ordered Today → This week."""
    from apps.tasks.models import FocusItem

    if mcp_user is None:
        raise ValueError(
            "list_focus requires an authenticated MCP user — set "
            "CYT_MCP_TOKEN as an OAuth bearer or run via stdio with a user."
        )
    qs = (
        FocusItem.objects.filter(user=mcp_user)
        .select_related("task", "task__column", "task__project")
        .prefetch_related("task__assignees", "task__labels")
        .order_by("period", "position", "id")
    )
    return [_focus_dict(item) for item in qs]


def add_focus(*, key: str, period: str = "week", mcp_user) -> dict[str, Any]:
    """Pin a task to the caller's focus list. Idempotent on (user, task);
    re-calling with a different ``period`` moves the pin between buckets."""
    from apps.tasks.focus import add_focus as _add

    if mcp_user is None:
        raise ValueError("add_focus requires an authenticated MCP user.")
    item = _add(user=mcp_user, task_key=key, period=period)
    return _focus_dict(item)


def remove_focus(*, key: str, mcp_user) -> dict[str, Any]:
    """Unpin a task from the caller's focus list. Returns ``{"removed": bool}``."""
    from apps.tasks.focus import remove_focus as _remove

    if mcp_user is None:
        raise ValueError("remove_focus requires an authenticated MCP user.")
    removed = _remove(user=mcp_user, task_key=key)
    return {"removed": removed, "key": key}


# ---------------------------------------------------------------------------
# Outbound webhooks
# ---------------------------------------------------------------------------


def _webhook_dict(ep, *, include_secret: bool = False) -> dict[str, Any]:
    d = {
        "id": ep.id,
        "name": ep.name,
        "url": ep.url,
        "event_types": ep.event_types,
        "scope": ep.scope,
        "project_id": ep.project_id,
        "include_self": ep.include_self,
        "active": ep.active,
        "consecutive_failures": ep.consecutive_failures,
        "disabled_at": ep.disabled_at.isoformat() if ep.disabled_at else None,
        "created_at": ep.created_at.isoformat(),
        "updated_at": ep.updated_at.isoformat(),
    }
    if include_secret:
        d["secret"] = ep.secret
    return d


def _webhook_delivery_dict(d) -> dict[str, Any]:
    return {
        "id": str(d.id),
        "endpoint_id": d.endpoint_id,
        "event": d.event,
        "task_key": d.task_key,
        "status": d.status,
        "attempts": d.attempts,
        "next_attempt_at": d.next_attempt_at.isoformat() if d.next_attempt_at else None,
        "last_attempt_at": d.last_attempt_at.isoformat() if d.last_attempt_at else None,
        "response_status": d.response_status,
        "error": d.error,
        "created_at": d.created_at.isoformat(),
    }


def register_webhook(
    *,
    name: str,
    url: str,
    event_types: list[str] | None = None,
    project: str | int | None = None,
    include_self: bool = False,
    scope: str = "mine",
    mcp_user,
) -> dict[str, Any]:
    """Register an outbound webhook endpoint for the calling user.

    Returns the endpoint dict **including the one-time signing secret**."""
    import secrets as _secrets
    from urllib.parse import urlsplit

    from apps.webhooks.models import WEBHOOK_EVENT_TYPES, WebhookEndpoint, WebhookScope

    if mcp_user is None:
        raise ValueError(
            "register_webhook requires an authenticated MCP user — set "
            "CYT_MCP_TOKEN as an OAuth bearer or run via stdio with a user."
        )
    if urlsplit(url).scheme.lower() not in ("http", "https"):
        raise ValueError("url must use http or https.")
    event_types = event_types or []
    bad = set(event_types) - set(WEBHOOK_EVENT_TYPES)
    if bad:
        raise ValueError(
            f"Unknown event type(s): {sorted(bad)}. "
            f"Allowed: {sorted(WEBHOOK_EVENT_TYPES)} (empty = all)."
        )
    if scope not in (WebhookScope.MINE, WebhookScope.ALL):
        raise ValueError(
            f"Unknown scope {scope!r}. Use 'mine' or 'all'."
        )
    project_obj = _resolve_project(project) if project is not None else None
    ep = WebhookEndpoint.objects.create(
        user=mcp_user,
        name=name,
        url=url,
        event_types=event_types,
        project=project_obj,
        include_self=include_self,
        scope=scope,
        secret=_secrets.token_hex(32),
    )
    return _webhook_dict(ep, include_secret=True)


def list_webhooks(*, mcp_user) -> list[dict[str, Any]]:
    """List the calling user's webhook endpoints (secrets excluded)."""
    from apps.webhooks.models import WebhookEndpoint

    if mcp_user is None:
        raise ValueError("list_webhooks requires an authenticated MCP user.")
    qs = WebhookEndpoint.objects.filter(user=mcp_user)
    return [_webhook_dict(ep) for ep in qs]


def delete_webhook(*, webhook_id: int, mcp_user) -> dict[str, Any]:
    """Delete one of the calling user's webhook endpoints."""
    from apps.webhooks.models import WebhookEndpoint

    if mcp_user is None:
        raise ValueError("delete_webhook requires an authenticated MCP user.")
    deleted, _ = WebhookEndpoint.objects.filter(
        id=webhook_id, user=mcp_user
    ).delete()
    return {"deleted": bool(deleted), "id": webhook_id}


def list_webhook_deliveries(
    *, webhook_id: int | None = None, limit: int = 20, mcp_user
) -> list[dict[str, Any]]:
    """Recent webhook deliveries across the caller's endpoints, newest first."""
    from apps.webhooks.models import WebhookDelivery

    if mcp_user is None:
        raise ValueError(
            "list_webhook_deliveries requires an authenticated MCP user."
        )
    qs = WebhookDelivery.objects.filter(endpoint__user=mcp_user)
    if webhook_id is not None:
        qs = qs.filter(endpoint_id=webhook_id)
    limit = max(1, min(int(limit), 100))
    return [_webhook_delivery_dict(d) for d in qs[:limit]]


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------


def list_labels(project: str | int | None = None) -> list[dict[str, Any]]:
    qs = Label.objects.all()
    if project is not None:
        proj = _resolve_project(project)
        qs = qs.filter(Q(project=proj) | Q(project__isnull=True))
    return [_label_dict(l) for l in qs.order_by(F("project_id").asc(nulls_last=True), "name")]


@transaction.atomic
def create_label(
    name: str,
    color: str = "#888888",
    project: str | int | None = None,
) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("Label name must not be empty.")
    proj = _resolve_project(project) if project is not None else None
    label, _ = Label.objects.get_or_create(
        project=proj,
        name=name,
        defaults={"color": color},
    )
    return _label_dict(label)


# ---------------------------------------------------------------------------
# Bets (Cyt OS)
# ---------------------------------------------------------------------------
# Bets are project-specific and live on a fixed two-month period grid
# (anchored 2026-07-01 — see apps.tasks.periods). Tasks link to the bet they
# serve; progress is tracked per bet through metrics with an append-only
# check-in log (optional numeric value and/or free-text note per check-in).


def _resolve_bet(ref: str | int, *, project: Project | None = None) -> Bet:
    """Accept a bet id, or a name (scoped to ``project`` when given). Names
    can repeat across periods — the most recent period wins."""
    qs = Bet.objects.all()
    if project is not None:
        qs = qs.filter(project=project)
    if isinstance(ref, int):
        return qs.get(pk=ref)
    if isinstance(ref, str):
        if ref.isdigit():
            return qs.get(pk=int(ref))
        match = qs.filter(name__iexact=ref).order_by("-period_start").first()
        if match is None:
            scope = f" in project {project.prefix}" if project else ""
            raise Bet.DoesNotExist(f"No bet named {ref!r}{scope}.")
        return match
    raise ValueError(f"Invalid bet reference: {ref!r}")


def _parse_period(period: str | None) -> Any:
    """``None``/``"current"`` → current period start; ISO date → snapped to
    its containing period; ``"all"`` → None (no period filter)."""
    from datetime import date

    if period is None or period == "current":
        return current_period_start()
    if period == "all":
        return None
    try:
        return period_start_for(date.fromisoformat(period))
    except ValueError as e:
        raise ValueError(
            f'period must be "current", "all", or an ISO date — got {period!r}'
        ) from e


def _checkin_dict(c: Checkin) -> dict[str, Any]:
    return {
        "id": c.id,
        "metric_id": c.metric_id,
        "value": c.value,
        "note": c.note,
        "created_by": c.created_by.username if c.created_by_id else None,
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    }


def _metric_dict(m: Metric, *, include_checkins: bool = True) -> dict[str, Any]:
    checkins = list(m.checkins.all())  # newest first (model ordering)
    latest = checkins[0] if checkins else None
    data = {
        "id": m.id,
        "bet_id": m.bet_id,
        "name": m.name,
        "target": m.target,
        "unit": m.unit,
        "latest_value": latest.value if latest else None,
        "latest_checkin_at": latest.created_at.isoformat() if latest else None,
    }
    if include_checkins:
        data["checkins"] = [_checkin_dict(c) for c in checkins]
    return data


def _bet_dict(b: Bet, *, include_metrics: bool = True) -> dict[str, Any]:
    tasks = list(b.tasks.all())
    data = {
        "id": b.id,
        "project": b.project.prefix,
        "name": b.name,
        "description": b.description,
        "color": b.color,
        "status": b.status,
        "period_start": b.period_start.isoformat(),
        "period_end": period_end(b.period_start).isoformat(),
        "period_label": period_label(b.period_start),
        "task_count": len(tasks),
        "done_task_count": sum(
            1 for t in tasks if t.column_id and t.column.is_done
        ),
        "tasks": [
            {"key": t.key, "title": t.title, "column": t.column.name if t.column_id else None}
            for t in tasks
        ],
        "created_at": b.created_at.isoformat(),
        "updated_at": b.updated_at.isoformat(),
    }
    if include_metrics:
        data["metrics"] = [_metric_dict(m) for m in b.metrics.all()]
    return data


def _bet_queryset():
    return (
        Bet.objects.all()
        .select_related("project")
        .prefetch_related("metrics__checkins", "tasks__column")
    )


def list_bets(
    project: str | int | None = None,
    period: str | None = "current",
    status: str | None = None,
) -> list[dict[str, Any]]:
    qs = _bet_queryset()
    if project is not None:
        qs = qs.filter(project=_resolve_project(project))
    period_start = _parse_period(period)
    if period_start is not None:
        qs = qs.filter(period_start=period_start)
    if status is not None:
        if status not in BetStatus.values:
            raise ValueError(
                f"Unknown status {status!r}. Use one of: {', '.join(BetStatus.values)}."
            )
        qs = qs.filter(status=status)
    return [_bet_dict(b) for b in qs.order_by("-period_start", "name")]


def get_bet(bet: str | int, project: str | int | None = None) -> dict[str, Any]:
    proj = _resolve_project(project) if project is not None else None
    resolved = _resolve_bet(bet, project=proj)
    return _bet_dict(_bet_queryset().get(pk=resolved.pk))


@transaction.atomic
def create_bet(
    project: str | int,
    name: str,
    description: str = "",
    color: str = "#6366f1",
    period: str | None = "current",
    status: str = "active",
) -> dict[str, Any]:
    proj = _resolve_project(project)
    name = (name or "").strip()
    if not name:
        raise ValueError("Bet name must not be empty.")
    if status not in BetStatus.values:
        raise ValueError(
            f"Unknown status {status!r}. Use one of: {', '.join(BetStatus.values)}."
        )
    period_start = _parse_period(period)
    if period_start is None:  # "all" makes no sense on create
        raise ValueError('period must be "current" or an ISO date on create.')
    bet = Bet.objects.create(
        project=proj,
        name=name,
        description=description or "",
        color=color,
        status=status,
        period_start=period_start,
    )
    broadcast_task_event(proj.id, "bet.created", {"bet_id": bet.id})
    return _bet_dict(bet)


@transaction.atomic
def update_bet(
    bet: str | int,
    project: str | int | None = None,
    name: str | None = None,
    description: str | None = None,
    color: str | None = None,
    status: str | None = None,
    period: str | None = None,
) -> dict[str, Any]:
    proj = _resolve_project(project) if project is not None else None
    b = _resolve_bet(bet, project=proj)
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("Bet name must not be empty.")
        b.name = name
    if description is not None:
        b.description = description
    if color is not None:
        b.color = color
    if status is not None:
        if status not in BetStatus.values:
            raise ValueError(
                f"Unknown status {status!r}. Use one of: {', '.join(BetStatus.values)}."
            )
        b.status = status
    if period is not None:
        period_start = _parse_period(period)
        if period_start is None:
            raise ValueError('period must be "current" or an ISO date.')
        b.period_start = period_start
    b.save()
    broadcast_task_event(b.project_id, "bet.updated", {"bet_id": b.id})
    return _bet_dict(_bet_queryset().get(pk=b.pk))


@transaction.atomic
def delete_bet(bet: str | int, project: str | int | None = None) -> dict[str, Any]:
    proj = _resolve_project(project) if project is not None else None
    b = _resolve_bet(bet, project=proj)
    project_id, bet_id = b.project_id, b.id
    b.delete()  # Task.bet is SET_NULL — linked tasks survive, unlinked
    broadcast_task_event(project_id, "bet.deleted", {"bet_id": bet_id})
    return {"id": bet_id, "deleted": True}


@transaction.atomic
def create_metric(
    bet: str | int,
    name: str,
    target: float | None = None,
    unit: str = "",
    project: str | int | None = None,
) -> dict[str, Any]:
    proj = _resolve_project(project) if project is not None else None
    b = _resolve_bet(bet, project=proj)
    name = (name or "").strip()
    if not name:
        raise ValueError("Metric name must not be empty.")
    metric = Metric.objects.create(bet=b, name=name, target=target, unit=unit or "")
    broadcast_task_event(b.project_id, "bet.updated", {"bet_id": b.id})
    return _metric_dict(metric)


@transaction.atomic
def update_metric(
    metric_id: int,
    name: str | None = None,
    target: float | None = None,
    unit: str | None = None,
    clear_target: bool = False,
) -> dict[str, Any]:
    metric = Metric.objects.select_related("bet").get(pk=metric_id)
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("Metric name must not be empty.")
        metric.name = name
    if clear_target:
        metric.target = None
    elif target is not None:
        metric.target = target
    if unit is not None:
        metric.unit = unit
    metric.save()
    broadcast_task_event(
        metric.bet.project_id, "bet.updated", {"bet_id": metric.bet_id}
    )
    return _metric_dict(metric)


@transaction.atomic
def delete_metric(metric_id: int) -> dict[str, Any]:
    metric = Metric.objects.select_related("bet").get(pk=metric_id)
    project_id, bet_id = metric.bet.project_id, metric.bet_id
    metric.delete()
    broadcast_task_event(project_id, "bet.updated", {"bet_id": bet_id})
    return {"id": metric_id, "deleted": True}


@transaction.atomic
def add_checkin(
    metric_id: int,
    value: float | None = None,
    note: str = "",
    mcp_user=None,
) -> dict[str, Any]:
    metric = Metric.objects.select_related("bet").get(pk=metric_id)
    if value is None and not (note or "").strip():
        raise ValueError("A check-in needs a value, a note, or both.")
    checkin = Checkin.objects.create(
        metric=metric, value=value, note=note or "", created_by=mcp_user
    )
    broadcast_task_event(
        metric.bet.project_id, "bet.updated", {"bet_id": metric.bet_id}
    )
    return _checkin_dict(checkin)


@transaction.atomic
def update_checkin(
    checkin_id: int,
    value: float | None = None,
    note: str | None = None,
    clear_value: bool = False,
) -> dict[str, Any]:
    checkin = Checkin.objects.select_related("metric__bet").get(pk=checkin_id)
    if clear_value:
        checkin.value = None
    elif value is not None:
        checkin.value = value
    if note is not None:
        checkin.note = note
    if checkin.value is None and not (checkin.note or "").strip():
        raise ValueError("A check-in needs a value, a note, or both.")
    checkin.save()
    bet = checkin.metric.bet
    broadcast_task_event(bet.project_id, "bet.updated", {"bet_id": bet.id})
    return _checkin_dict(checkin)


@transaction.atomic
def delete_checkin(checkin_id: int) -> dict[str, Any]:
    checkin = Checkin.objects.select_related("metric__bet").get(pk=checkin_id)
    bet = checkin.metric.bet
    checkin.delete()
    broadcast_task_event(bet.project_id, "bet.updated", {"bet_id": bet.id})
    return {"id": checkin_id, "deleted": True}


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def list_views(project: str | int | None = None) -> list[dict[str, Any]]:
    qs = View.objects.all().select_related("owner", "project")
    if project is not None:
        proj = _resolve_project(project)
        qs = qs.filter(project=proj)
    return [_view_dict(v) for v in qs.order_by("name")]


def query_view(view: str | int) -> list[dict[str, Any]]:
    if isinstance(view, int) or (isinstance(view, str) and view.isdigit()):
        v = View.objects.get(pk=int(view))
    else:
        v = View.objects.filter(name=view).first()
        if v is None:
            raise View.DoesNotExist(f"No view named {view!r}.")
    qs = filter_and_sort_tasks(v.filters, v.sort)
    return [_task_dict(t, include_description=False) for t in qs]


# ---------------------------------------------------------------------------
# Recurring tasks
# ---------------------------------------------------------------------------


@transaction.atomic
def create_recurring_task(
    project: str | int,
    title: str,
    schedule: str,
    dtstart: str | None = None,
    timezone_name: str = "UTC",
    description: str = "",
    assignees: list[str | int] | None = None,
    priority: str | None = None,
    labels: list[str | int] | None = None,
    story_points: int | None = None,
    column: str | int | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    proj = _resolve_project(project)
    col = _resolve_column(proj, column)
    assignee_users = [_resolve_user(ref) for ref in assignees] if assignees else []
    reporter = _resolve_reporter_for_mcp(mcp_user)

    rrule = parse_schedule(schedule)
    start = _parse_iso_datetime(dtstart) if dtstart else timezone.now()
    validate_rrule(rrule, start)

    tpl = RecurringTaskTemplate(
        project=proj,
        column=col,
        title=title,
        description=description or "",
        priority=_normalize_priority(priority),
        story_points=story_points,
        rrule=rrule,
        dtstart=start,
        timezone=timezone_name,
        next_run_at=compute_initial_next_run(rrule, start),
        created_by=reporter,
        active=True,
    )
    tpl.save()
    if labels:
        tpl.labels.set(_resolve_labels(proj, labels))
    if assignee_users:
        tpl.assignees.set(assignee_users)
    return _template_dict(tpl)


def list_recurring_tasks(
    project: str | int | None = None, active: bool | None = None
) -> list[dict[str, Any]]:
    qs = RecurringTaskTemplate.objects.all().select_related(
        "project", "column", "created_by"
    ).prefetch_related("labels", "assignees")
    if project is not None:
        qs = qs.filter(project=_resolve_project(project))
    if active is not None:
        qs = qs.filter(active=active)
    return [_template_dict(tpl) for tpl in qs.order_by("next_run_at")]


@transaction.atomic
def update_recurring_task(
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
    tpl = RecurringTaskTemplate.objects.get(pk=id)

    if title is not None:
        tpl.title = title
    if description is not None:
        tpl.description = description
    if priority is not None:
        tpl.priority = _normalize_priority(priority) or tpl.priority
    if story_points is not None:
        tpl.story_points = story_points
    if column is not None:
        tpl.column = _resolve_column(tpl.project, column)

    if schedule is not None or dtstart is not None:
        rrule = parse_schedule(schedule) if schedule is not None else tpl.rrule
        start = _parse_iso_datetime(dtstart) if dtstart else tpl.dtstart
        validate_rrule(rrule, start)
        tpl.rrule = rrule
        tpl.dtstart = start
        tpl.next_run_at = compute_initial_next_run(rrule, start)

    tpl.save()
    if assignees is not None:
        tpl.assignees.set([_resolve_user(ref) for ref in assignees])
    return _template_dict(tpl)


@transaction.atomic
def pause_recurring_task(id: int) -> dict[str, Any]:
    tpl = RecurringTaskTemplate.objects.get(pk=id)
    tpl.active = False
    tpl.save(update_fields=["active", "updated_at"])
    return {"ok": True, "id": tpl.id, "active": tpl.active}


@transaction.atomic
def resume_recurring_task(id: int) -> dict[str, Any]:
    tpl = RecurringTaskTemplate.objects.get(pk=id)
    tpl.active = True
    if tpl.next_run_at < timezone.now():
        tpl.next_run_at = compute_initial_next_run(tpl.rrule, tpl.dtstart)
    tpl.save(update_fields=["active", "next_run_at", "updated_at"])
    return {
        "ok": True,
        "id": tpl.id,
        "active": tpl.active,
        "next_run_at": tpl.next_run_at.isoformat(),
    }


@transaction.atomic
def delete_recurring_task(id: int) -> dict[str, Any]:
    tpl = RecurringTaskTemplate.objects.get(pk=id)
    tpl.delete()
    return {"ok": True, "id": id}


def preview_recurring_task(id: int, count: int = 5) -> dict[str, Any]:
    tpl = RecurringTaskTemplate.objects.get(pk=id)
    count = max(1, min(50, count))
    occurrences = preview_occurrences(tpl, count=count)
    return {
        "id": tpl.id,
        "title": tpl.title,
        "rrule": tpl.rrule,
        "occurrences": [dt.isoformat() for dt in occurrences],
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_iso_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise ValueError(
            f"Invalid ISO-8601 timestamp {value!r}: {e}"
        ) from e
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _resolve_reporter_for_mcp(user=None):
    """Return the user that MCP-created tasks should be reported by.

    When *user* is provided (e.g. from an OAuth-authenticated MCP session),
    it is used directly. Otherwise we fall back to the heuristic chain:
    ``CYT_MCP_DEFAULT_USERNAME`` → first superuser → first staff → first user.
    """
    if user is not None:
        return user

    from django.conf import settings

    configured = getattr(settings, "CYT_MCP_DEFAULT_USERNAME", None)
    if configured:
        try:
            return User.objects.get(username=configured)
        except User.DoesNotExist:
            pass

    for query in (
        User.objects.filter(is_superuser=True, is_active=True),
        User.objects.filter(is_staff=True, is_active=True),
        User.objects.filter(is_active=True),
    ):
        user = query.order_by("id").first()
        if user is not None:
            return user

    raise RuntimeError(
        "No users exist. Create one with `python manage.py createsuperuser` "
        "before using the MCP server."
    )


# ---------------------------------------------------------------------------
# Wiki (docs)
# ---------------------------------------------------------------------------
#
# A hierarchical, workspace-global knowledge base (Notion-style page tree).
# MCP READs pages, manages STRUCTURE/METADATA (title / parent / project), and
# writes the page BODY via Markdown. The body is a Yjs CRDT owned by the live
# collaborative editor; rather than re-encode it in Python (fragile), body
# writes are delegated to a frontend route that reuses the editor's exact
# yjs/@slate-yjs/core, and the resulting update is applied to the live room +
# persisted. See ``apps.wiki.content_ops`` and the ``*_wiki_content`` tools in
# ``server.py``.

from apps.wiki.broadcast import broadcast_wiki_event
from apps.wiki.models import Doc as WikiDoc
from apps.wiki.query import (
    base_doc_queryset as base_wiki_queryset,
    filter_and_sort_docs as filter_and_sort_wiki_docs,
)


def _resolve_wiki_doc(ref: str | int) -> WikiDoc:
    if isinstance(ref, int):
        return WikiDoc.objects.get(pk=ref)
    if isinstance(ref, str):
        if ref.isdigit():
            return WikiDoc.objects.get(pk=int(ref))
        return WikiDoc.objects.get(key=ref)
    raise ValueError(f"Invalid doc reference: {ref!r}")


def _wiki_doc_dict(d: WikiDoc, *, include_content: bool = False) -> dict[str, Any]:
    data = {
        "id": d.id,
        "key": d.key,
        "title": d.title,
        "parent": d.parent.key if d.parent_id else None,
        "parent_id": d.parent_id,
        "position": d.position,
        "project": d.project.name if d.project_id else None,
        "project_id": d.project_id,
        "has_children": getattr(d, "has_children", None),
        "created_by": d.created_by.username if d.created_by_id else None,
        "last_edited_by": (
            d.last_edited_by.username if d.last_edited_by_id else None
        ),
        "created_at": d.created_at.isoformat(),
        "updated_at": d.updated_at.isoformat(),
    }
    if include_content:
        data["content"] = d.content
        data["text"] = d.plain_text
    return data


def list_wiki_docs(
    parent: str | int | None = None,
    project: str | int | None = None,
    search: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {}
    if parent is not None:
        if isinstance(parent, str) and parent.lower() in ("root", "none", "null"):
            filters["parent"] = "root"
        else:
            filters["parent"] = _resolve_wiki_doc(parent).id
    if project is not None:
        if isinstance(project, str) and project.lower() in ("none", "null"):
            filters["project"] = "none"
        else:
            filters["project"] = _resolve_project(project).id
    if search:
        filters["search"] = search
    qs = filter_and_sort_wiki_docs(filters=filters)
    return [_wiki_doc_dict(d) for d in qs[:limit]]


def get_wiki_doc(key: str) -> dict[str, Any]:
    from apps.wiki.content_ops import serialize_markdown

    d = base_wiki_queryset().get(key=key)
    data = _wiki_doc_dict(d, include_content=True)
    markdown = serialize_markdown(d.content)
    if markdown is not None:
        data["markdown"] = markdown
    return data


def _wiki_tail_position(parent_id: int | None, *, exclude_id: int | None = None) -> float:
    qs = WikiDoc.objects.filter(parent_id=parent_id)
    if exclude_id is not None:
        qs = qs.exclude(pk=exclude_id)
    tail = qs.aggregate(m=Max("position"))["m"]
    return (tail or 0) + 1000.0


@transaction.atomic
def create_wiki_doc(
    title: str = "Untitled",
    parent: str | int | None = None,
    project: str | int | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    actor = _resolve_reporter_for_mcp(mcp_user)
    parent_obj = _resolve_wiki_doc(parent) if parent is not None else None
    project_obj = _resolve_project(project) if project is not None else None

    doc = WikiDoc(
        title=title or "Untitled",
        parent=parent_obj,
        project=project_obj,
        created_by=actor,
        last_edited_by=actor,
    )
    doc.save()
    broadcast_wiki_event(
        "wiki.created",
        {"key": doc.key, "id": doc.id, "parent_id": doc.parent_id},
    )
    fresh = base_wiki_queryset().get(pk=doc.pk)
    return _wiki_doc_dict(fresh, include_content=True)


@transaction.atomic
def update_wiki_doc(
    key: str,
    title: str | None = None,
    parent: str | int | None = None,
    project: str | int | None = None,
    clear_parent: bool = False,
    clear_project: bool = False,
) -> dict[str, Any]:
    from apps.wiki.views import _would_cycle

    doc = WikiDoc.objects.get(key=key)
    parent_changed = False

    if title is not None:
        doc.title = title

    if clear_parent:
        doc.parent = None
        parent_changed = True
    elif parent is not None:
        parent_obj = _resolve_wiki_doc(parent)
        if parent_obj.id == doc.id:
            raise ValueError("A page cannot be its own parent.")
        if _would_cycle(parent_obj.id, doc.id):
            raise ValueError("Cannot move a page into its own subtree.")
        doc.parent = parent_obj
        parent_changed = True

    if clear_project:
        doc.project = None
    elif project is not None:
        doc.project = _resolve_project(project)

    if parent_changed:
        doc.position = _wiki_tail_position(doc.parent_id, exclude_id=doc.id)

    doc.save()
    broadcast_wiki_event(
        "wiki.updated",
        {"key": doc.key, "id": doc.id, "parent_id": doc.parent_id},
    )
    fresh = base_wiki_queryset().get(pk=doc.pk)
    return _wiki_doc_dict(fresh, include_content=True)


@transaction.atomic
def delete_wiki_doc(key: str) -> dict[str, Any]:
    doc = WikiDoc.objects.get(key=key)
    doc_id = doc.id
    doc.delete()  # cascades the subtree
    broadcast_wiki_event("wiki.deleted", {"key": key})
    return {"deleted": key, "id": doc_id}


# ---------------------------------------------------------------------------
# Drive (Backblaze B2 object storage)
# ---------------------------------------------------------------------------
#
# The company file drive, backed by the cyt-drive B2 bucket. B2 is the source of
# truth (no models). Agents get list / read / upload. Delete is intentionally
# NOT exposed over MCP — deletes touch real company files (UI/human only).

def drive_list(prefix: str = "", token: str | None = None) -> dict[str, Any]:
    from apps.drive import b2
    return b2.list_objects(prefix, token=token)


def drive_read(key: str, max_bytes: int = 65536) -> dict[str, Any]:
    from apps.drive import b2

    max_bytes = min(max(0, max_bytes), 1_048_576)  # cap at 1 MB — no OOM via a huge read
    meta = b2.head(key)
    if meta is None:
        raise ValueError(f"No such Drive object: {key!r}")
    out = dict(meta)
    out["url"] = b2.presign_get(key, download_name=meta.get("name"))
    # Best-effort inline text for small, texty objects.
    ctype = meta.get("content_type") or ""
    ext = (meta.get("name") or "").rsplit(".", 1)[-1].lower()
    texty = (
        ctype.startswith("text/")
        or ctype in ("application/json", "application/xml", "application/x-yaml")
        or ext in ("md", "txt", "csv", "json", "yaml", "yml", "log",
                   "py", "js", "ts", "tsx", "html", "css")
    )
    if texty and 0 < meta.get("size", 0) <= max_bytes:
        try:
            out["text"] = b2.get_bytes(key, max_bytes=max_bytes).decode("utf-8")
        except Exception:
            pass
    return out


def drive_upload(key: str, content: str = "", content_base64: str | None = None,
                 content_type: str = "text/plain; charset=utf-8",
                 mcp_user=None) -> dict[str, Any]:
    import base64 as _b64
    import binascii
    import logging

    from apps.drive import b2

    if content and content_base64:
        raise ValueError("Provide either `content` or `content_base64`, not both.")
    if content_base64 is not None:
        if len(content_base64) > 14_000_000:  # ~10 MB decoded — guard the stdio transport
            raise ValueError("content_base64 too large (max ~10 MB).")
        try:
            data = _b64.b64decode(content_base64, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError(f"Invalid base64 content: {exc}") from exc
    else:
        data = content.encode("utf-8")

    result = b2.put_bytes(key, data, content_type)
    if mcp_user is not None:  # attribute the write for audit (B2 has no per-user field)
        logging.getLogger("apps.mcp_server").info(
            "drive_upload by %s -> %s (%d bytes)",
            getattr(mcp_user, "username", mcp_user), result.get("key"),
            result.get("size", 0),
        )
    return result


# ---------------------------------------------------------------------------
# Knowledge (LLM wiki — markdown pages in B2 under the llm-wiki/ prefix)
# ---------------------------------------------------------------------------
#
# The Karpathy-style wiki: markdown pages an agent maintains. Humans read only
# (via the /api/knowledge DRF endpoints + frontend tab); agents create/update
# here. Single writer, last-write-wins — no synthesis worker yet.

def knowledge_list() -> list[dict[str, Any]]:
    from apps.drive import b2
    return b2.wiki_list()


def knowledge_read(slug: str) -> dict[str, Any]:
    from apps.drive import b2
    return b2.wiki_read(slug)


def knowledge_sources() -> list[dict[str, Any]]:
    from apps.drive import b2
    return b2.manifest_sources()


WIKI_SCHEMA = """Cyt Software LLM Wiki — conventions. READ THIS before writing pages.

You maintain a SHARED markdown knowledge base. Pages are nested; the slug IS a
directory path. Put every page in the right directory — never at the root.

Directory taxonomy (slug prefix):
- entities/people/<name>       individuals (clients, prospects, contacts)
- entities/companies/<name>    companies (clients, prospects, vendors, competitors)
- entities/products/<name>     third-party products/services we use or evaluate
- concepts/<name>              ideas, methods, frameworks, market observations
- projects/<name>              Cyt Software projects/products/initiatives
- decisions/<name>             ADR-style decisions
- sources/<name>               one summary page per ingested source document

Slugs are kebab-case, one entity/concept per page (e.g. entities/people/john-smith).

Frontmatter — REQUIRED on every page:
---
title: Page Title
type: person|company|product|project|concept|decision|source
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [..]
---
Person pages also add: company, role, relationship, last_contact, next_followup.
Company pages add: relationship, status. Project pages add: status, owner.
Source pages add: source (the drive key), ingested.

Cross-references: use [[entities/people/john-smith]] wikilinks for EVERY mention
of another entity/concept — they render as clickable links.

Auto-maintained BY THE SERVER (do NOT write or edit these yourself):
- index   the catalog — regenerated on every write/delete
- log     the activity log — appended on every write/delete
Just write your content pages; the index and log update themselves.

Before writing: knowledge_read the page if it may exist and UPDATE it in place
(don't duplicate). Never file secrets/credentials/tokens, or personal content.
"""


def knowledge_schema() -> dict[str, Any]:
    """Return the wiki conventions (directory layout, frontmatter, wikilinks)."""
    return {"schema": WIKI_SCHEMA}


def _agent_name(mcp_user) -> str:
    return getattr(mcp_user, "username", None) or "mcp"


def knowledge_write(slug: str, markdown: str, mcp_user=None) -> dict[str, Any]:
    import logging

    from apps.drive import b2

    if len((markdown or "").encode("utf-8")) > 5_000_000:
        raise ValueError("Markdown too large (max 5 MB per wiki page).")
    if b2._wiki_norm(slug) in b2.RESERVED_SLUGS:
        raise ValueError(
            "'index' and 'log' are auto-maintained by the server. Write your "
            "content pages (e.g. entities/people/<name>) — the index and log "
            "update automatically. Call knowledge_schema for the conventions."
        )
    result = b2.wiki_write(slug, markdown)
    b2.append_log("write", f"wrote {result['slug']}", [result["slug"]], _agent_name(mcp_user))
    try:
        b2.rebuild_index()
    except Exception:
        logging.getLogger("apps.drive").warning("rebuild_index failed", exc_info=True)
    if mcp_user is not None:
        logging.getLogger("apps.mcp_server").info(
            "knowledge_write by %s -> %s (%d bytes)",
            _agent_name(mcp_user), result.get("slug"), result.get("size", 0),
        )
    return result


def knowledge_delete(slug: str, mcp_user=None) -> dict[str, Any]:
    import logging

    from apps.drive import b2

    norm = b2._wiki_norm(slug)
    if norm in b2.RESERVED_SLUGS:
        raise ValueError("Cannot delete the auto-maintained 'index'/'log' pages.")
    result = b2.wiki_delete(slug)
    b2.append_log("delete", f"deleted {norm}", [norm], _agent_name(mcp_user))
    try:
        b2.rebuild_index()
    except Exception:
        logging.getLogger("apps.drive").warning("rebuild_index failed", exc_info=True)
    return result


def knowledge_reindex() -> dict[str, Any]:
    from apps.drive import b2

    return b2.rebuild_index()
