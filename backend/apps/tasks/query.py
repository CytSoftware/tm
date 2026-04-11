"""Shared task query helpers.

The DRF viewset and the MCP tools both need to filter and sort tasks by the
same predicates. This module is the **single source of truth** for that logic.
Do not duplicate filtering code in either consumer — extend these functions
instead.

Inputs are a ``filters`` dict and a ``sort`` list using the same shape that a
saved ``View`` stores in its JSON fields:

    filters = {
        "assignee": [1, 2],            # user ids OR usernames OR "me"
        "priority": ["P1", "P2"],      # P1 = highest, P4 = lowest
        "labels": [3],                 # label ids OR names
        "column": 7,                   # column id OR name
        "project": 1,                  # project id OR prefix
        "search": "oauth",             # case-insensitive substring match on key+title
    }

    sort = [
        {"field": "priority", "dir": "desc"},
        {"field": "updated_at", "dir": "desc"},
    ]

All filter keys are optional; missing keys are ignored. Unknown keys are
ignored silently (saved views may carry fields this version doesn't know yet).
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from django.contrib.auth import get_user_model
from django.db.models import Case, IntegerField, Q, QuerySet, When

from .models import Label, Priority, Project, Task

User = get_user_model()

# Priority sort order — P1 (highest) first when dir=desc.
PRIORITY_RANK = {
    Priority.P1: 4,
    Priority.P2: 3,
    Priority.P3: 2,
    Priority.P4: 1,
}

SORTABLE_FIELDS = {
    "created_at",
    "updated_at",
    "due_at",
    "title",
    "position",
    "story_points",
    "priority",  # special-cased into a Case/When rank
}


def base_task_queryset() -> QuerySet[Task]:
    """Pre-joined task queryset used by every code path."""
    return (
        Task.objects.select_related(
            "project", "column", "reporter", "recurrence_template"
        )
        .prefetch_related("labels", "assignees")
        .order_by("project_id", "column__order", "position", "id")
    )


def _resolve_user_ids(values: Iterable[Any], requesting_user) -> list[int]:
    """Accept a mix of ints, usernames, and the magic string ``"me"``."""
    ids: list[int] = []
    usernames: list[str] = []
    for v in values:
        if isinstance(v, int):
            ids.append(v)
        elif isinstance(v, str):
            if v == "me" and requesting_user and requesting_user.is_authenticated:
                ids.append(requesting_user.pk)
            elif v.isdigit():
                ids.append(int(v))
            else:
                usernames.append(v)
    if usernames:
        ids.extend(
            User.objects.filter(username__in=usernames).values_list("id", flat=True)
        )
    return ids


def _resolve_label_ids(
    values: Iterable[Any], *, project: Project | None = None
) -> list[int]:
    ids: list[int] = []
    names: list[str] = []
    for v in values:
        if isinstance(v, int):
            ids.append(v)
        elif isinstance(v, str):
            if v.isdigit():
                ids.append(int(v))
            else:
                names.append(v)
    if names:
        qs = Label.objects.filter(name__in=names)
        if project is not None:
            qs = qs.filter(project=project)
        ids.extend(qs.values_list("id", flat=True))
    return ids


def _resolve_project(value: Any) -> Project | None:
    """Accept a project id (int or numeric string) or a prefix string."""
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return Project.objects.filter(pk=value).first()
    if isinstance(value, str):
        if value.isdigit():
            return Project.objects.filter(pk=int(value)).first()
        return Project.objects.filter(prefix__iexact=value).first()
    return None


def apply_task_filters(
    qs: QuerySet[Task],
    filters: Mapping[str, Any] | None,
    *,
    requesting_user=None,
) -> QuerySet[Task]:
    """Apply the saved-view-style filter dict to a Task queryset."""
    if not filters:
        return qs

    # Project
    if (raw_project := filters.get("project")) not in (None, ""):
        project = _resolve_project(raw_project)
        if project is None:
            return qs.none()
        qs = qs.filter(project=project)
    else:
        project = None

    # Assignee — matches any task where one of the listed users is in the
    # task's assignees M2M.
    if assignee_values := filters.get("assignee"):
        if not isinstance(assignee_values, (list, tuple)):
            assignee_values = [assignee_values]
        ids = _resolve_user_ids(assignee_values, requesting_user)
        qs = qs.filter(assignees__id__in=ids).distinct() if ids else qs.none()

    # Priority
    if priority_values := filters.get("priority"):
        if not isinstance(priority_values, (list, tuple)):
            priority_values = [priority_values]
        priority_values = [p.upper() for p in priority_values if isinstance(p, str)]
        qs = qs.filter(priority__in=priority_values)

    # Labels (matches any)
    if label_values := filters.get("labels"):
        if not isinstance(label_values, (list, tuple)):
            label_values = [label_values]
        ids = _resolve_label_ids(label_values, project=project)
        qs = qs.filter(labels__id__in=ids).distinct() if ids else qs.none()

    # Column
    if (raw_column := filters.get("column")) not in (None, ""):
        if isinstance(raw_column, int) or (isinstance(raw_column, str) and raw_column.isdigit()):
            qs = qs.filter(column_id=int(raw_column))
        elif isinstance(raw_column, str):
            qs = qs.filter(column__name__iexact=raw_column)

    # Free-text search (key + title)
    if search := filters.get("search"):
        if isinstance(search, str) and search.strip():
            q = search.strip()
            qs = qs.filter(Q(key__icontains=q) | Q(title__icontains=q))

    return qs


def apply_task_sort(
    qs: QuerySet[Task], sort: list[Mapping[str, str]] | None
) -> QuerySet[Task]:
    """Apply a saved-view sort spec. Falls back to the default Task ordering."""
    if not sort:
        return qs

    order_fields: list[str] = []
    needs_priority_rank = False

    for entry in sort:
        field = entry.get("field")
        direction = (entry.get("dir") or "asc").lower()
        if not field or field not in SORTABLE_FIELDS:
            continue
        prefix = "-" if direction == "desc" else ""
        if field == "priority":
            needs_priority_rank = True
            order_fields.append(f"{prefix}_priority_rank")
        else:
            order_fields.append(f"{prefix}{field}")

    if not order_fields:
        return qs

    if needs_priority_rank:
        qs = qs.annotate(
            _priority_rank=Case(
                *[
                    When(priority=p, then=rank)
                    for p, rank in PRIORITY_RANK.items()
                ],
                default=0,
                output_field=IntegerField(),
            )
        )

    # Stable tie-breaker on id so pagination is deterministic.
    return qs.order_by(*order_fields, "id")


def filter_and_sort_tasks(
    filters: Mapping[str, Any] | None = None,
    sort: list[Mapping[str, str]] | None = None,
    *,
    requesting_user=None,
    base: QuerySet[Task] | None = None,
) -> QuerySet[Task]:
    """One-shot helper used by both DRF and MCP."""
    qs = base if base is not None else base_task_queryset()
    qs = apply_task_filters(qs, filters, requesting_user=requesting_user)
    qs = apply_task_sort(qs, sort)
    return qs
