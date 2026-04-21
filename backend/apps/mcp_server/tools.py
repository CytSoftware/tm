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
    }
    if include_description:
        data["description"] = t.description
    return data


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
