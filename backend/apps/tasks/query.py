"""Shared task query helpers.

The DRF viewset and the MCP tools both need to filter and sort tasks by the
same predicates. This module is the **single source of truth** for that logic.
Do not duplicate filtering code in either consumer — extend these functions
instead.

Inputs are a ``filters`` dict and a ``sort`` list using the same shape that a
saved ``View`` stores in its JSON fields:

    filters = {
        "assignee": [1, 2],            # user ids OR usernames OR "me"
        "reviewer": ["me"],            # user ids OR usernames OR "me"/"none"
        "priority": ["P1", "P2"],      # P1 = highest, P4 = lowest
        "labels": [3],                 # label ids OR names
        "column": 7,                   # column id OR name
        "project": 1,                  # project id OR prefix
        "bet": 4,                      # bet id OR name, or "none" for unlinked
        "done": False,                 # True = in an is_done column, False = not
        "search": "oauth",             # case-insensitive substring match on key+title
        "include_archived": False,     # when NO project filter is set: False
                                       # hides archived-project tasks, True (or
                                       # absent) includes them
    }

    sort = [
        {"field": "priority", "dir": "desc"},
        {"field": "updated_at", "dir": "desc"},
    ]

All filter keys are optional; missing keys are ignored. Unknown keys are
ignored silently (saved views may carry fields this version doesn't know yet).
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

from django.contrib.auth import get_user_model
from django.db.models import (
    Case,
    IntegerField,
    OuterRef,
    Prefetch,
    Q,
    QuerySet,
    Subquery,
    When,
)

from .models import Bet, Column, Label, Priority, Project, StateTransition, Task

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
    # "staleness" sorts by `current_column_since` asc = most stale first;
    # tasks that never transitioned into their current column (or have no
    # column) sort last regardless of direction thanks to NULL handling.
    "staleness",
    "current_column_since",
}


def base_task_queryset() -> QuerySet[Task]:
    """Pre-joined task queryset used by every code path.

    Annotates ``current_column_since`` — the ``at`` timestamp of the most
    recent :class:`StateTransition` whose ``to_column`` matches the task's
    current column. Tasks that haven't transitioned into their current
    column (e.g. legacy tasks not yet backfilled) get ``NULL``.
    """
    latest_entry = (
        StateTransition.objects.filter(
            task=OuterRef("pk"), to_column=OuterRef("column")
        )
        .order_by("-at")
        .values("at")[:1]
    )
    # `UserSerializer.get_avatar_url` reads `user.profile` for both the
    # reporter and every assignee. Without these prefetches each card
    # serialization triggers an N+1 lookup for the OneToOne profile row.
    return (
        Task.objects.select_related(
            "project",
            "column",
            "reporter",
            "reporter__profile",
            "reviewer",
            "reviewer__profile",
            "recurrence_template",
            "bet",
        )
        .prefetch_related(
            "labels",
            Prefetch(
                "assignees",
                queryset=User.objects.select_related("profile"),
            ),
            "pull_requests__repository",
        )
        .annotate(current_column_since=Subquery(latest_entry))
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


# Matches a task-key-like token: a prefix, a hyphen, and a run of digits
# (e.g. ``MOW-42``, ``cyt-007``). The prefix part mirrors how keys are built.
_KEY_TOKEN_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]*)-0*(\d+)$")


def _key_search_variants(word: str) -> list[str]:
    """Zero-padding-normalized key variants for a hyphenated token.

    Task keys are stored zero-padded to at least three digits (``MOW-042``),
    but users naturally type the unpadded number (``MOW-42``) or an
    over-padded one (``MOW-0042``). Given such a token, return the canonical
    padded form so the caller can OR it into a ``key__icontains`` match.
    Returns an empty list for tokens that don't look like a key.
    """
    match = _KEY_TOKEN_RE.match(word)
    if not match:
        return []
    prefix, digits = match.group(1), match.group(2)
    number = int(digits)
    variants = {f"{prefix}-{number:03d}", f"{prefix}-{number}"}
    # Drop the variant identical (case-insensitively) to what was typed; it
    # adds nothing beyond the existing raw ``key__icontains=word`` clause.
    return [v for v in variants if v.lower() != word.lower()]


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

    # Archived projects. When the query spans all projects (no ``project``
    # filter), the board's all-projects view opts into hiding tasks that live
    # in archived projects by passing ``include_archived=False``. A specific
    # ``project`` filter already narrows to one project, so this only bites
    # unscoped listings. The key being *absent* means "no opinion" and leaves
    # archived tasks in — so MCP ``list_tasks`` and direct saved-view API
    # callers keep their existing behaviour; only callers that explicitly send
    # a falsy flag get the exclusion. Inbox tasks (no project) are always kept.
    if (
        project is None
        and (include_archived := filters.get("include_archived")) is not None
        and not include_archived
    ):
        qs = qs.filter(Q(project__isnull=True) | Q(project__archived=False))

    # Assignee — matches any task where one of the listed users is in the
    # task's assignees M2M.  The sentinel ``"none"`` matches unassigned tasks.
    if assignee_values := filters.get("assignee"):
        if not isinstance(assignee_values, (list, tuple)):
            assignee_values = [assignee_values]
        include_none = "none" in assignee_values
        real_values = [v for v in assignee_values if v != "none"]
        ids = _resolve_user_ids(real_values, requesting_user) if real_values else []
        if include_none and ids:
            qs = qs.filter(Q(assignees__id__in=ids) | Q(assignees__isnull=True)).distinct()
        elif include_none:
            qs = qs.filter(assignees__isnull=True)
        elif ids:
            qs = qs.filter(assignees__id__in=ids).distinct()
        else:
            qs = qs.none()

    # Reviewer — same value handling as assignee, but ``Task.reviewer`` is a
    # single FK so no ``.distinct()`` is needed. ``"none"`` matches tasks with
    # no reviewer set.
    if reviewer_values := filters.get("reviewer"):
        if not isinstance(reviewer_values, (list, tuple)):
            reviewer_values = [reviewer_values]
        include_none = "none" in reviewer_values
        real_values = [v for v in reviewer_values if v != "none"]
        ids = _resolve_user_ids(real_values, requesting_user) if real_values else []
        if include_none and ids:
            qs = qs.filter(Q(reviewer_id__in=ids) | Q(reviewer__isnull=True))
        elif include_none:
            qs = qs.filter(reviewer__isnull=True)
        elif ids:
            qs = qs.filter(reviewer_id__in=ids)
        else:
            qs = qs.none()

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

    # Bet — id, name (scoped to the project filter when one is set; bet names
    # can repeat across periods, so a name matches all of them), or the
    # sentinel ``"none"`` for tasks not linked to any bet.
    if (raw_bet := filters.get("bet")) not in (None, ""):
        if raw_bet == "none":
            qs = qs.filter(bet__isnull=True)
        elif isinstance(raw_bet, int) or (
            isinstance(raw_bet, str) and raw_bet.isdigit()
        ):
            qs = qs.filter(bet_id=int(raw_bet))
        elif isinstance(raw_bet, str):
            bet_qs = Bet.objects.filter(name__iexact=raw_bet)
            if project is not None:
                bet_qs = bet_qs.filter(project=project)
            ids = list(bet_qs.values_list("id", flat=True))
            qs = qs.filter(bet_id__in=ids) if ids else qs.none()

    # Done — True keeps only tasks sitting in an ``is_done`` column; False
    # keeps everything else (columnless tasks count as open, hence exclude).
    if (raw_done := filters.get("done")) not in (None, ""):
        truthy = raw_done in (True, 1) or (
            isinstance(raw_done, str) and raw_done.lower() in ("1", "true", "yes")
        )
        if truthy:
            qs = qs.filter(column__is_done=True)
        else:
            qs = qs.exclude(column__is_done=True)

    # Free-text search (key + title + description). Whitespace-separated
    # words are ANDed: every token must appear somewhere across those fields.
    if search := filters.get("search"):
        if isinstance(search, str) and (stripped := search.strip()):
            for word in stripped.split():
                if word.isdigit():
                    # Bare number → the task numbered N. Anchor to the key's
                    # "-NNN" suffix (zero-padded) so "85" finds MOW-085 but not
                    # the noise of MOW-185 / MOW-850 that a loose substring hits.
                    number = int(word)
                    key_cond = Q(key__iendswith=f"-{number:03d}") | Q(
                        key__iendswith=f"-{number}"
                    )
                else:
                    # Keys are stored zero-padded (e.g. ``MOW-042``), so a raw
                    # substring match on an unpadded token like ``MOW-42`` misses.
                    # Add the zero-padded variant so users can type the natural,
                    # unpadded number.
                    key_cond = Q(key__icontains=word)
                    for variant in _key_search_variants(word):
                        key_cond |= Q(key__icontains=variant)
                qs = qs.filter(
                    key_cond
                    | Q(title__icontains=word)
                    | Q(description__icontains=word)
                )

    return qs


def _resolve_column_for_sort(
    filters: Mapping[str, Any] | None,
) -> Column | None:
    """Resolve a single-column filter to its :class:`Column`, for the
    Done-column recency-sort default (Linear-style).

    Returns ``None`` unless the filters narrow to exactly one column: an id
    filter resolves to that column; a name filter (e.g. the all-projects
    board's ``"Done"``) resolves only when *every* column of that name is
    ``is_done`` — so a mixed set never silently flips ordering. Any other
    shape (no column filter, unknown id/name) yields ``None`` and leaves the
    default position ordering in place.
    """
    if not filters:
        return None
    raw = filters.get("column")
    if raw in (None, ""):
        return None
    if isinstance(raw, int) or (isinstance(raw, str) and raw.isdigit()):
        return Column.objects.filter(pk=int(raw)).first()
    if isinstance(raw, str):
        cols = list(Column.objects.filter(name__iexact=raw))
        if cols and all(c.is_done for c in cols):
            return cols[0]
    return None


def apply_task_sort(
    qs: QuerySet[Task],
    sort: list[Mapping[str, str]] | None,
    column: Column | None = None,
) -> QuerySet[Task]:
    """Apply a saved-view sort spec. Falls back to the default Task ordering.

    When no explicit ``sort`` is given and ``column`` is a Done column
    (``is_done``), tasks are ordered by ``current_column_since`` descending —
    most recently completed first, matching Linear's Done column. An explicit
    sort always wins, so a saved view's sort overrides the recency default.
    """
    if not sort:
        if column is not None and column.is_done:
            # Most recently moved into the Done column first. Stable id
            # tie-breaker so pagination is deterministic.
            return qs.order_by("-current_column_since", "id")
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
        elif field == "staleness":
            # "Most stale first" = oldest current_column_since first, so
            # "asc" (the button label users will read as "most stale first")
            # maps to current_column_since ASC. Invert for desc.
            order_fields.append(f"{prefix}current_column_since")
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
    # Only resolve the column when there's no explicit sort — it's the sole
    # case the Done-recency default applies, and resolving costs a query.
    column = _resolve_column_for_sort(filters) if not sort else None
    qs = apply_task_sort(qs, sort, column=column)
    return qs
