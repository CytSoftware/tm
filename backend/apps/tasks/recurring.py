"""Recurring task generation.

Scheduled work:
    generate_due_instances(now)  — one pass that creates tasks for any template
                                   whose ``next_run_at`` has passed, recomputes
                                   ``next_run_at``, and broadcasts task.created.

Helpers:
    parse_schedule(schedule)     — turn a preset or raw RRULE into a valid
                                   RRULE string (used by MCP and API).
    validate_rrule(rrule, dtstart) — raises ValueError on invalid input.
    compute_initial_next_run(...)  — used when saving a new template.
    compute_next_run_after(...)    — used after generating an instance.

Both the management command and the lazy middleware call
``generate_due_instances``; both entry points are safe to run concurrently
thanks to ``transaction.atomic`` + ``select_for_update``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable

from dateutil.rrule import rrulestr
from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from .models import Column, RecurringTaskTemplate, Task


# ---------------------------------------------------------------------------
# Preset → RRULE translation (used by MCP tools and frontend shortcuts)
# ---------------------------------------------------------------------------

_WEEKDAY_CODES = {
    "mon": "MO",
    "tue": "TU",
    "wed": "WE",
    "thu": "TH",
    "fri": "FR",
    "sat": "SA",
    "sun": "SU",
}


def parse_schedule(schedule: str) -> str:
    """Translate a preset like ``"daily"`` or ``"weekly:mon,wed"`` to an RRULE.

    Accepts:
    - ``"daily"``                    → ``FREQ=DAILY``
    - ``"weekdays"``                 → ``FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR``
    - ``"weekly"``                   → ``FREQ=WEEKLY``
    - ``"weekly:mon,wed"``           → ``FREQ=WEEKLY;BYDAY=MO,WE``
    - ``"monthly"``                  → ``FREQ=MONTHLY``
    - ``"monthly:15"``               → ``FREQ=MONTHLY;BYMONTHDAY=15``
    - Any string containing ``FREQ=`` is passed through unchanged.
    """
    if not schedule:
        raise ValueError("schedule must not be empty")

    s = schedule.strip()
    if "FREQ=" in s.upper():
        return s

    lowered = s.lower()

    if lowered == "daily":
        return "FREQ=DAILY"

    if lowered == "weekdays":
        return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"

    if lowered.startswith("weekly"):
        if ":" in lowered:
            _, days_part = lowered.split(":", 1)
            codes = []
            for token in days_part.split(","):
                token = token.strip().lower()[:3]
                if token not in _WEEKDAY_CODES:
                    raise ValueError(f"Unknown weekday in schedule preset: {token!r}")
                codes.append(_WEEKDAY_CODES[token])
            if not codes:
                raise ValueError("weekly:… preset requires at least one day")
            return f"FREQ=WEEKLY;BYDAY={','.join(codes)}"
        return "FREQ=WEEKLY"

    if lowered.startswith("monthly"):
        if ":" in lowered:
            _, day_part = lowered.split(":", 1)
            day_part = day_part.strip()
            if not day_part.isdigit() or not (1 <= int(day_part) <= 31):
                raise ValueError(
                    f"monthly:<day> requires a day between 1 and 31, got {day_part!r}"
                )
            return f"FREQ=MONTHLY;BYMONTHDAY={int(day_part)}"
        return "FREQ=MONTHLY"

    if lowered == "yearly":
        return "FREQ=YEARLY"

    raise ValueError(
        f"Unknown schedule preset {schedule!r}. "
        "Use one of: daily, weekdays, weekly[:days], monthly[:day], yearly, or a raw RRULE."
    )


# ---------------------------------------------------------------------------
# Validation + next-run computation
# ---------------------------------------------------------------------------


def validate_rrule(rrule: str, dtstart: datetime) -> None:
    """Raise ``ValueError`` if the RRULE cannot be parsed with this dtstart."""
    try:
        rrulestr(rrule, dtstart=dtstart)
    except (ValueError, TypeError) as e:
        raise ValueError(f"invalid rrule: {e}") from e


def compute_initial_next_run(rrule: str, dtstart: datetime) -> datetime:
    """Return the first scheduled occurrence at-or-after now.

    If ``dtstart`` is in the future, that's the first run. If it's in the past,
    walk the rrule forward until we find an occurrence ≥ now. Exhausted rules
    return the dtstart so the caller can mark ``active=False`` explicitly if
    needed.
    """
    rule = rrulestr(rrule, dtstart=dtstart)
    now = timezone.now()
    if dtstart >= now:
        return dtstart
    next_occurrence = rule.after(now, inc=True)
    return next_occurrence or dtstart


def compute_next_run_after(
    template: RecurringTaskTemplate, after: datetime
) -> datetime | None:
    """Return the next occurrence strictly after ``after``, or None if exhausted."""
    rule = rrulestr(template.rrule, dtstart=template.dtstart)
    return rule.after(after, inc=False)


def preview_occurrences(
    template: RecurringTaskTemplate, count: int = 5
) -> list[datetime]:
    """Return the next ``count`` occurrences at-or-after now, for UI previews."""
    rule = rrulestr(template.rrule, dtstart=template.dtstart)
    now = timezone.now()
    results: list[datetime] = []
    current = rule.after(now, inc=True)
    while current and len(results) < count:
        results.append(current)
        current = rule.after(current, inc=False)
    return results


# ---------------------------------------------------------------------------
# The generator
# ---------------------------------------------------------------------------


def _next_top_position(column: Column) -> float:
    """Return a position value that sorts above all existing tasks in ``column``.

    We use ``min_position - 1000`` (or a sensible default when empty).
    """
    current_min = column.tasks.aggregate(m=Max("position"))["m"]
    if current_min is None:
        return 1000.0
    return current_min + 1000.0


#: Safety cap on how many missed occurrences a single template can generate in
#: one pass. Prevents a pathological template (e.g. FREQ=HOURLY starting years
#: ago) from generating thousands of tasks on its first run. Templates that hit
#: the cap can be re-processed on the next generator call.
MAX_CATCHUP_PER_TEMPLATE = 50


@transaction.atomic
def generate_due_instances(now: datetime | None = None) -> list[Task]:
    """Materialize all templates whose ``next_run_at`` has passed.

    For each due template, generates one ``Task`` per missed occurrence and
    advances ``next_run_at`` until it passes ``now``, the rule exhausts, or
    the per-template catch-up cap is hit.

    Safe to call from the management command and the lazy middleware
    concurrently — ``select_for_update`` + SQLite's file lock serialize writes.
    """
    # Local import to avoid pulling channels into non-web code paths.
    from .broadcast import broadcast_task_event

    now = now or timezone.now()
    created: list[Task] = []

    templates = list(
        RecurringTaskTemplate.objects.select_for_update()
        .filter(active=True, next_run_at__lte=now)
        .select_related("project", "column", "assignee", "created_by")
    )

    for tpl in templates:
        tpl_label_ids = list(tpl.labels.values_list("id", flat=True))
        iterations = 0

        while (
            tpl.active
            and tpl.next_run_at <= now
            and iterations < MAX_CATCHUP_PER_TEMPLATE
        ):
            iterations += 1

            task = Task(
                project=tpl.project,
                column=tpl.column,
                title=tpl.title,
                description=tpl.description,
                assignee=tpl.assignee,
                priority=tpl.priority,
                story_points=tpl.story_points,
                reporter=tpl.created_by,
                recurrence_template=tpl,
                due_at=tpl.next_run_at,
                position=_next_top_position(tpl.column),
            )
            task.save()  # fires the key-generation logic
            if tpl_label_ids:
                task.labels.set(tpl_label_ids)

            broadcast_task_event(
                tpl.project_id,
                "task.created",
                {"key": task.key, "id": task.id},
            )
            created.append(task)

            # Advance to the next scheduled occurrence strictly after the one
            # we just materialized. When the rule is exhausted, mark inactive
            # and break.
            next_occurrence = compute_next_run_after(tpl, after=tpl.next_run_at)
            if next_occurrence is None:
                tpl.active = False
                break
            tpl.next_run_at = next_occurrence

        tpl.last_generated_at = now
        tpl.save(
            update_fields=[
                "last_generated_at",
                "next_run_at",
                "active",
                "updated_at",
            ]
        )

    return created
