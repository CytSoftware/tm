"""Flow analytics — the single source of truth for throughput and completions.

Both the DRF views (``ThroughputView``, ``WeeklyCompletionsView``) and the
matching MCP tools (``get_throughput``, ``get_weekly_completions``) call the
functions here; the math lives in this module and nowhere else, mirroring the
single-source discipline of :mod:`apps.tasks.query`.

Everything is derived from the immutable :class:`~apps.tasks.models.StateTransition`
log, bucketed into local calendar days. The four series answer:

* ``created``   — explicit creation events. Every task emits
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

from django.contrib.auth import get_user_model
from django.db.models import Count, QuerySet
from django.db.models.functions import TruncDate

from .models import ColumnKind, StateTransition, TransitionEvent

User = get_user_model()

# Guardrail shared with the view/tool so an accidental multi-year window can't
# fan out into an unbounded day list.
MAX_RANGE_DAYS = 366

# Guardrail shared with the view/tool for the weekly-completions trend length.
MAX_WEEKS = 52


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
    counter = Count("task_id_snapshot", distinct=True) if distinct else Count("id")
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
        base = base.filter(project_id_snapshot=project_id)

    created = _bucket_by_day(
        base.filter(event_type=TransitionEvent.CREATED),
        tz,
        date_from,
        date_to,
        distinct=False,
    )
    started = _bucket_by_day(
        base.filter(to_column_kind=ColumnKind.IN_PROGRESS),
        tz,
        date_from,
        date_to,
        distinct=True,
    )
    in_review = _bucket_by_day(
        base.filter(to_column_kind=ColumnKind.REVIEW),
        tz,
        date_from,
        date_to,
        distinct=True,
    )
    completed = _bucket_by_day(
        base.filter(to_column_is_done=True),
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


# ---------------------------------------------------------------------------
# Weekly completions
# ---------------------------------------------------------------------------


def _week_start(d: date) -> date:
    """Monday of the calendar week containing ``d``."""
    return d - timedelta(days=d.weekday())


def _avatar_url(user, request) -> str | None:
    # Mirrors UserSerializer.get_avatar_url, minus the DRF context plumbing —
    # this module is called from the MCP tool too, which has no ``request``.
    profile = getattr(user, "profile", None)
    raw = profile.effective_avatar_url if profile else ""
    if not raw:
        return None
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if request is not None:
        return request.build_absolute_uri(raw)
    return raw


def weekly_completions(
    project_id: int | None,
    week: date,
    weeks: int,
    tz: ZoneInfo,
    *,
    request=None,
) -> dict:
    """Weekly completion counts, overall and per person.

    A completion is a :class:`~apps.tasks.models.StateTransition` into an
    ``is_done`` column. Weeks are Monday-start, bucketed in ``tz`` the same
    way ``throughput`` buckets days — ``TruncDate(..., tzinfo=tz)`` converts
    in-database, then the (small) result set is grouped into weeks in Python;
    correctness over cleverness at this volume.

    Per task per week, only the LATEST completion transition counts: a task
    toggled done twice in the same week is one completion, not two, and its
    per-person credit comes from that latest transition's ``assignee_ids``
    snapshot — not whichever assignees are on the task *now*. ``total`` (and
    each ``trend`` entry) is always the distinct-task count for that week;
    multi-assignee tasks are credited to every assignee in ``per_person`` but
    never summed into ``total``.

    ``request`` is optional, used only to turn a stored relative avatar path
    into an absolute URL. The MCP tool has no request and passes ``None``.
    """
    week_start = _week_start(week)
    week_end = week_start + timedelta(days=6)
    prev_week_start = week_start - timedelta(weeks=1)
    trend_start = week_start - timedelta(weeks=weeks - 1)
    # The trend window and the single "previous week" comparison don't
    # necessarily overlap (e.g. weeks=1), so fetch the union of both spans.
    fetch_start = min(trend_start, prev_week_start)

    base = StateTransition.objects.filter(to_column_is_done=True)
    if project_id is not None:
        base = base.filter(project_id_snapshot=project_id)

    day = TruncDate("at", tzinfo=tz)
    rows = (
        base.annotate(day=day)
        .filter(day__gte=fetch_start, day__lte=week_end)
        .order_by("at", "id")
        .values_list("task_id_snapshot", "day", "assignee_ids")
    )

    # weekly[week_monday][task_id] = assignee_ids snapshot of the LATEST
    # completion of that task within that week. Rows are consumed in ``at``
    # order, so a later row for the same (week, task) simply overwrites the
    # earlier one — a cheap way to keep only the canonical event per task-week.
    weekly: dict[date, dict[int, list[int]]] = {}
    for task_id, day_value, assignee_ids in rows:
        wk = _week_start(day_value)
        weekly.setdefault(wk, {})[task_id] = assignee_ids or []

    def _total_for(wk: date) -> int:
        return len(weekly.get(wk, {}))

    def _per_person_for(wk: date) -> dict[int | None, int]:
        counts: dict[int | None, int] = {}
        for assignee_ids in weekly.get(wk, {}).values():
            if not assignee_ids:
                counts[None] = counts.get(None, 0) + 1
            else:
                for uid in assignee_ids:
                    counts[uid] = counts.get(uid, 0) + 1
        return counts

    total = _total_for(week_start)
    prev_total = _total_for(prev_week_start)
    cur_counts = _per_person_for(week_start)
    prev_counts = _per_person_for(prev_week_start)

    user_ids = [uid for uid in cur_counts if uid is not None]
    users = {
        u.id: u
        for u in User.objects.filter(id__in=user_ids).select_related("profile")
    }

    per_person: list[dict] = []
    for uid, count in cur_counts.items():
        user = users.get(uid) if uid is not None else None
        per_person.append(
            {
                "user_id": uid,
                "username": user.username if user else None,
                "avatar_url": _avatar_url(user, request) if user else None,
                "count": count,
                "prev_count": prev_counts.get(uid, 0),
            }
        )
    # Real users sorted by count desc; Unassigned (user_id=None) always sorts
    # last, regardless of its own count.
    per_person.sort(key=lambda p: (p["user_id"] is None, -p["count"]))

    trend: list[dict] = []
    cursor = trend_start
    while cursor <= week_start:
        trend.append({"week_start": cursor.isoformat(), "total": _total_for(cursor)})
        cursor += timedelta(weeks=1)

    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "total": total,
        "prev_total": prev_total,
        "per_person": per_person,
        "trend": trend,
    }
