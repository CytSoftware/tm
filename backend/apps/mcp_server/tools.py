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
    Column,
    Label,
    Priority,
    Project,
    RecurringTaskTemplate,
    Task,
    TransitionSource,
    View,
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
) -> dict[str, Any]:
    task = base_task_queryset().get(key=key)
    dirty = False

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

    if dirty:
        task.save()
    if labels is not None:
        task.labels.set(_resolve_labels(task.project, labels))
    if assignees is not None:
        task.assignees.set([_resolve_user(ref) for ref in assignees])

    broadcast_task_event(
        task.project_id, "task.updated", {"key": task.key, "id": task.id}
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
    if (old_column.id if old_column else None) != col.id:
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
    return _task_dict(task)


@transaction.atomic
def delete_task(key: str) -> dict[str, Any]:
    task = base_task_queryset().get(key=key)
    project_id = task.project_id
    task_key = task.key
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
# Pipelines
# ---------------------------------------------------------------------------
#
# Pipelines are long-running tracked processes (bank applications, vendor
# onboarding, leads). They share Stage / position / drag-drop semantics with
# Tasks but live on their own global kanban with their own MCP surface.

from apps.pipelines.broadcast import broadcast_pipeline_event
from apps.pipelines.models import Pipeline, PipelineEvent, Stage
from apps.pipelines.query import (
    base_pipeline_queryset,
    filter_and_sort_pipelines,
)


def _resolve_stage(ref: str | int) -> Stage:
    if isinstance(ref, int):
        return Stage.objects.get(pk=ref)
    if isinstance(ref, str):
        if ref.isdigit():
            return Stage.objects.get(pk=int(ref))
        return Stage.objects.get(name__iexact=ref)
    raise ValueError(f"Invalid stage reference: {ref!r}")


def _stage_dict(s: Stage) -> dict[str, Any]:
    return {
        "id": s.id,
        "name": s.name,
        "order": s.order,
        "color": s.color,
        "is_terminal": s.is_terminal,
    }


def _pipeline_dict(p: Pipeline, *, include_events: bool = False) -> dict[str, Any]:
    data = {
        "id": p.id,
        "key": p.key,
        "title": p.title,
        "description": p.description,
        "counterparty": p.counterparty,
        "stage": p.stage.name if p.stage_id else None,
        "stage_id": p.stage_id,
        "position": p.position,
        "owner": p.owner.username if p.owner_id else None,
        "event_count": getattr(p, "event_count", None),
        "last_event_at": (
            p.last_event_at.isoformat()
            if getattr(p, "last_event_at", None)
            else None
        ),
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }
    if include_events:
        data["events"] = [
            _pipeline_event_dict(e) for e in p.events.order_by("created_at", "id")
        ]
    return data


def _pipeline_event_dict(e: PipelineEvent) -> dict[str, Any]:
    return {
        "id": e.id,
        "pipeline_id": e.pipeline_id,
        "body": e.body,
        "author": e.author.username if e.author_id else None,
        "created_at": e.created_at.isoformat(),
    }


def list_stages() -> list[dict[str, Any]]:
    return [_stage_dict(s) for s in Stage.objects.order_by("order")]


def list_pipelines(
    stage: str | int | None = None,
    owner: str | None = None,
    search: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {}
    if stage is not None:
        filters["stage"] = stage
    if owner:
        filters["owner"] = [owner]
    if search:
        filters["search"] = search
    qs = filter_and_sort_pipelines(filters=filters)
    return [_pipeline_dict(p) for p in qs[:limit]]


def get_pipeline(key: str) -> dict[str, Any]:
    p = base_pipeline_queryset().get(key=key)
    return _pipeline_dict(p, include_events=True)


@transaction.atomic
def create_pipeline(
    title: str,
    description: str = "",
    counterparty: str = "",
    stage: str | int | None = None,
    owner: str | int | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    if stage is not None:
        stage_obj = _resolve_stage(stage)
    else:
        stage_obj = Stage.objects.order_by("order").first()
        if stage_obj is None:
            raise ValueError("No stages have been seeded.")

    actor = _resolve_reporter_for_mcp(mcp_user)
    owner_user = _resolve_user(owner) if owner is not None else actor

    pipeline = Pipeline(
        title=title,
        description=description or "",
        counterparty=counterparty or "",
        stage=stage_obj,
        owner=owner_user,
        created_by=actor,
    )
    pipeline.save()
    broadcast_pipeline_event(
        "pipeline.created", {"key": pipeline.key, "id": pipeline.id}
    )
    fresh = base_pipeline_queryset().get(pk=pipeline.pk)
    return _pipeline_dict(fresh)


@transaction.atomic
def update_pipeline(
    key: str,
    title: str | None = None,
    description: str | None = None,
    counterparty: str | None = None,
    owner: str | int | None = None,
) -> dict[str, Any]:
    pipeline = Pipeline.objects.get(key=key)

    if title is not None:
        pipeline.title = title
    if description is not None:
        pipeline.description = description
    if counterparty is not None:
        pipeline.counterparty = counterparty
    if owner is not None:
        pipeline.owner = _resolve_user(owner)

    pipeline.save()
    broadcast_pipeline_event(
        "pipeline.updated", {"key": pipeline.key, "id": pipeline.id}
    )
    fresh = base_pipeline_queryset().get(pk=pipeline.pk)
    return _pipeline_dict(fresh)


@transaction.atomic
def move_pipeline(
    key: str,
    stage: str | int,
    position: str | float | None = None,
) -> dict[str, Any]:
    pipeline = Pipeline.objects.get(key=key)
    stage_obj = _resolve_stage(stage)
    pipeline.stage = stage_obj

    if position is None or position == "bottom":
        pipeline.position = _next_pipeline_bottom_position(
            stage_obj, exclude_pipeline_id=pipeline.id
        )
    elif position == "top":
        pipeline.position = _next_pipeline_top_position(
            stage_obj, exclude_pipeline_id=pipeline.id
        )
    else:
        try:
            pipeline.position = float(position)
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"position must be 'top', 'bottom', or a number — got {position!r}"
            ) from e

    pipeline.save(update_fields=["stage", "position", "updated_at"])
    broadcast_pipeline_event(
        "pipeline.moved",
        {"key": pipeline.key, "id": pipeline.id, "stage_id": stage_obj.id},
    )
    fresh = base_pipeline_queryset().get(pk=pipeline.pk)
    return _pipeline_dict(fresh)


@transaction.atomic
def delete_pipeline(key: str) -> dict[str, Any]:
    pipeline = Pipeline.objects.get(key=key)
    pipeline_key = pipeline.key
    pipeline.delete()
    broadcast_pipeline_event("pipeline.deleted", {"key": pipeline_key})
    return {"ok": True, "key": pipeline_key}


@transaction.atomic
def log_pipeline_event(
    key: str,
    body: str,
    mcp_user=None,
) -> dict[str, Any]:
    pipeline = Pipeline.objects.get(key=key)
    actor = mcp_user if mcp_user is not None else None
    event = PipelineEvent.objects.create(
        pipeline=pipeline,
        body=body or "",
        author=actor,
    )
    broadcast_pipeline_event(
        "pipeline.event_added",
        {
            "key": pipeline.key,
            "id": pipeline.id,
            "event_id": event.id,
        },
    )
    return _pipeline_event_dict(event)


def list_pipeline_events(key: str) -> list[dict[str, Any]]:
    pipeline = Pipeline.objects.get(key=key)
    qs = pipeline.events.select_related("author").order_by("created_at", "id")
    return [_pipeline_event_dict(e) for e in qs]


def _next_pipeline_bottom_position(
    stage: Stage, *, exclude_pipeline_id: int | None = None
) -> float:
    qs = stage.pipelines.all()
    if exclude_pipeline_id is not None:
        qs = qs.exclude(id=exclude_pipeline_id)
    current_max = qs.aggregate(m=Max("position"))["m"]
    return (current_max or 0) + 1000.0


def _next_pipeline_top_position(
    stage: Stage, *, exclude_pipeline_id: int | None = None
) -> float:
    qs = stage.pipelines.all()
    if exclude_pipeline_id is not None:
        qs = qs.exclude(id=exclude_pipeline_id)
    current_min = qs.order_by("position").first()
    if current_min is None:
        return 1000.0
    return current_min.position - 1000.0


# =========================================================================
# CRM (Contacts)
# =========================================================================
# Contact CRUD with the same shape as the DRF viewset (single source of
# truth lives in apps.crm.query). No realtime broadcast in v1 — CRM is a
# table view, not a kanban with multiple watchers.

from apps.crm.country_codes import normalize_country
from apps.crm.models import (
    ALLOWED_SOCIAL_KEYS,
    Contact,
    ContactLabel,
)
from apps.crm.query import (
    apply_contact_filters,
    apply_contact_sort,
    base_contact_queryset,
)


def _contact_label_dict(label: ContactLabel) -> dict[str, Any]:
    return {
        "id": label.id,
        "name": label.name,
        "color": label.color,
    }


def _contact_dict(c: Contact) -> dict[str, Any]:
    return {
        "id": c.id,
        "key": c.key,
        "company": c.company,
        "first_name": c.first_name,
        "last_name": c.last_name,
        "industry": c.industry,
        "job_title": c.job_title,
        "email": c.email,
        "phone": c.phone,
        "address_line1": c.address_line1,
        "address_line2": c.address_line2,
        "city": c.city,
        "region": c.region,
        "postal_code": c.postal_code,
        "country": c.country,
        "websites": list(c.websites or []),
        "socials": dict(c.socials or {}),
        "labels": [_contact_label_dict(label) for label in c.labels.all()],
        "notes": c.notes,
        "created_by": c.created_by.username if c.created_by_id else None,
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    }


def _resolve_country_arg(value: str | None) -> str | None:
    """For filter/list args: turn a free-text country into ISO-2 (or pass through)."""
    if value is None or value == "":
        return None
    normalized = normalize_country(value)
    return normalized or value.strip().upper()[:2]


def list_contact_labels() -> list[dict[str, Any]]:
    return [_contact_label_dict(label) for label in ContactLabel.objects.all().order_by("name")]


def list_contacts(
    *,
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
    """List contacts with the same filter shape DRF uses."""
    filters: dict[str, Any] = {}
    if search:
        filters["search"] = search
    if (resolved_country := _resolve_country_arg(country)):
        filters["country"] = resolved_country
    if city:
        filters["city"] = city
    if industry:
        filters["industry"] = industry
    if job_title:
        filters["job_title"] = job_title
    if labels:
        filters["labels"] = labels
    if has_email is not None:
        filters["has_email"] = bool(has_email)
    if has_phone is not None:
        filters["has_phone"] = bool(has_phone)
    if has_linkedin is not None:
        filters["has_linkedin"] = bool(has_linkedin)
    if has_website is not None:
        filters["has_website"] = bool(has_website)

    sort = None
    if sort_field:
        direction = (sort_dir or "asc").lower()
        if direction not in {"asc", "desc"}:
            direction = "asc"
        sort = [{"field": sort_field, "dir": direction}]

    qs = apply_contact_sort(
        apply_contact_filters(base_contact_queryset(), filters),
        sort,
    )

    # Defensive bounds — protects the DB from bad MCP args.
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))

    total = qs.count()
    page = qs[offset : offset + limit]
    return {
        "count": total,
        "limit": limit,
        "offset": offset,
        "results": [_contact_dict(c) for c in page],
    }


def get_contact(key: str) -> dict[str, Any]:
    contact = base_contact_queryset().get(key=key)
    return _contact_dict(contact)


def _coerce_socials_payload(
    *,
    linkedin: str | None,
    twitter: str | None,
    facebook: str | None,
    instagram: str | None,
    existing: dict[str, str] | None = None,
) -> dict[str, str]:
    """Merge per-platform string args into a socials dict.

    None means "leave alone" (keep existing); empty string means "clear it";
    a value sets/replaces.
    """
    out: dict[str, str] = dict(existing or {})
    pairs = (
        ("linkedin", linkedin),
        ("twitter", twitter),
        ("facebook", facebook),
        ("instagram", instagram),
    )
    for key, value in pairs:
        if value is None:
            continue
        v = value.strip()
        if v:
            out[key] = v
        else:
            out.pop(key, None)
    # Belt-and-braces: drop any keys that snuck in from `existing` and aren't allowed.
    return {k: v for k, v in out.items() if k in ALLOWED_SOCIAL_KEYS}


def _resolve_or_create_label(name: str) -> ContactLabel:
    name = name.strip()
    label, _ = ContactLabel.objects.get_or_create(name=name)
    return label


@transaction.atomic
def create_contact(
    *,
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
    mcp_user=None,
) -> dict[str, Any]:
    if not any([company, first_name, last_name, email]):
        raise ValueError(
            "Provide at least one of: company, first_name, last_name, email."
        )

    sanitized_websites = [
        u.strip() for u in (websites or []) if isinstance(u, str) and u.strip()
    ]
    sanitized_socials = _coerce_socials_payload(
        linkedin=linkedin or None,
        twitter=twitter or None,
        facebook=facebook or None,
        instagram=instagram or None,
    )
    iso_country = (
        normalize_country(country) or country.strip().upper()[:2] if country else ""
    )

    contact = Contact(
        company=company,
        first_name=first_name,
        last_name=last_name,
        industry=industry,
        job_title=job_title,
        email=(email or "").lower(),
        phone=phone,
        address_line1=address_line1,
        address_line2=address_line2,
        city=city,
        region=region,
        postal_code=postal_code,
        country=iso_country,
        websites=sanitized_websites,
        socials=sanitized_socials,
        notes=notes,
        created_by=mcp_user if mcp_user is not None else None,
    )
    contact.save()

    if labels:
        for name in labels:
            if isinstance(name, str) and name.strip():
                contact.labels.add(_resolve_or_create_label(name))

    fresh = base_contact_queryset().get(pk=contact.pk)
    return _contact_dict(fresh)


@transaction.atomic
def update_contact(
    *,
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
    contact = Contact.objects.get(key=key)

    simple_fields = {
        "company": company,
        "first_name": first_name,
        "last_name": last_name,
        "industry": industry,
        "job_title": job_title,
        "phone": phone,
        "address_line1": address_line1,
        "address_line2": address_line2,
        "city": city,
        "region": region,
        "postal_code": postal_code,
        "notes": notes,
    }
    for field, value in simple_fields.items():
        if value is not None:
            setattr(contact, field, value)

    if email is not None:
        contact.email = (email or "").lower()

    if country is not None:
        if country == "":
            contact.country = ""
        else:
            iso = normalize_country(country)
            contact.country = iso or country.strip().upper()[:2]

    if websites is not None:
        contact.websites = [
            u.strip() for u in websites if isinstance(u, str) and u.strip()
        ]

    if any(v is not None for v in (linkedin, twitter, facebook, instagram)):
        contact.socials = _coerce_socials_payload(
            linkedin=linkedin,
            twitter=twitter,
            facebook=facebook,
            instagram=instagram,
            existing=contact.socials,
        )

    contact.save()
    fresh = base_contact_queryset().get(pk=contact.pk)
    return _contact_dict(fresh)


@transaction.atomic
def delete_contact(key: str) -> dict[str, Any]:
    contact = Contact.objects.get(key=key)
    deleted_key = contact.key
    contact.delete()
    return {"deleted": True, "key": deleted_key}


@transaction.atomic
def add_contact_label(*, key: str, label: str) -> dict[str, Any]:
    contact = Contact.objects.get(key=key)
    if not isinstance(label, str) or not label.strip():
        raise ValueError("Label name is required.")
    label_obj = _resolve_or_create_label(label)
    contact.labels.add(label_obj)
    fresh = base_contact_queryset().get(pk=contact.pk)
    return _contact_dict(fresh)


@transaction.atomic
def remove_contact_label(*, key: str, label: str) -> dict[str, Any]:
    contact = Contact.objects.get(key=key)
    label_obj = ContactLabel.objects.filter(name__iexact=(label or "").strip()).first()
    if label_obj is not None:
        contact.labels.remove(label_obj)
    fresh = base_contact_queryset().get(pk=contact.pk)
    return _contact_dict(fresh)


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
