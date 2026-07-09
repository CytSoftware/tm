"""Throughput analytics — the single source of truth for the flow metrics.

Both the DRF view (``ThroughputView``) and the MCP ``get_throughput`` tool call
:func:`throughput`; the math lives here and nowhere else, mirroring the
single-source discipline of :mod:`apps.tasks.query`.

Everything is derived from the immutable :class:`~apps.tasks.models.StateTransition`
log, bucketed into local calendar days. The four series answer:

* ``created``   — creation events (``from_column`` is null). Every task emits
  exactly one, so a plain count is correct.
* ``started``   — tasks that entered an ``in_progress`` column that day.
* ``in_review`` — tasks that entered a ``review`` column that day.
* ``completed`` — tasks that entered a done column (``is_done``) that day.

The three stage series count **distinct tasks per day**: a task bounced into
and back out of "in progress" twice in one day is one "started" for that day,
not two. ``created`` needs no distinct — a task is created once.

Day bucketing is timezone-aware: a transition at 22:00 UTC belongs to the next
calendar day when viewed from a UTC+3 zone. ``TruncDate(..., tzinfo=tz)`` does
the conversion in-database so it works identically on SQLite (today) and
Postgres (planned) — no raw SQL, no Python-side date math.
"""

from __future__ import annotations

from datetime import date, timedelta
from zoneinfo import ZoneInfo

from django.db.models import Count, QuerySet
from django.db.models.functions import TruncDate

from .models import ColumnKind, StateTransition

# Guardrail shared with the view/tool so an accidental multi-year window can't
# fan out into an unbounded day list.
MAX_RANGE_DAYS = 366


def _bucket_by_day(
    qs: QuerySet,
    tz: ZoneInfo,
    date_from: date,
    date_to: date,
    *,
    distinct: bool,
) -> dict[date, int]:
    """Group ``qs`` transitions into a ``{local_date: count}`` map.

    ``distinct`` counts distinct tasks per day (stage entries); otherwise a
    plain row count (creation events).
    """
    day = TruncDate("at", tzinfo=tz)
    counter = Count("task", distinct=True) if distinct else Count("id")
    rows = (
        qs.annotate(day=day)
        .filter(day__gte=date_from, day__lte=date_to)
        .values("day")
        .annotate(n=counter)
    )
    return {row["day"]: row["n"] for row in rows}


def throughput(
    project_id: int | None,
    date_from: date,
    date_to: date,
    tz: ZoneInfo,
) -> list[dict]:
    """Return one zero-filled row per calendar day in ``[date_from, date_to]``.

    Each row is ``{"date": "YYYY-MM-DD", "created", "started", "in_review",
    "completed"}`` with integer counts, ascending by date. ``project_id`` of
    ``None`` spans every project.
    """
    base = StateTransition.objects.all()
    if project_id is not None:
        base = base.filter(task__project_id=project_id)

    created = _bucket_by_day(
        base.filter(from_column__isnull=True),
        tz,
        date_from,
        date_to,
        distinct=False,
    )
    started = _bucket_by_day(
        base.filter(to_column__kind=ColumnKind.IN_PROGRESS),
        tz,
        date_from,
        date_to,
        distinct=True,
    )
    in_review = _bucket_by_day(
        base.filter(to_column__kind=ColumnKind.REVIEW),
        tz,
        date_from,
        date_to,
        distinct=True,
    )
    completed = _bucket_by_day(
        base.filter(to_column__is_done=True),
        tz,
        date_from,
        date_to,
        distinct=True,
    )

    days: list[dict] = []
    cursor = date_from
    while cursor <= date_to:
        days.append(
            {
                "date": cursor.isoformat(),
                "created": created.get(cursor, 0),
                "started": started.get(cursor, 0),
                "in_review": in_review.get(cursor, 0),
                "completed": completed.get(cursor, 0),
            }
        )
        cursor += timedelta(days=1)
    return days
