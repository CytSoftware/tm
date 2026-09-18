"""Single source of truth for meeting filtering and search.

Same contract as :mod:`apps.tasks.query`: the DRF viewset, the graph builder
and the MCP tools all go through ``filter_meetings`` — don't reimplement a
filter in any of them. Unknown filter keys are ignored.

Filter dict shape::

    {project, category, entity, person, company, tag, date_from, date_to, search}

Search is plain ``icontains``. That is deliberate: it is fast enough for
thousands of transcripts, and FTS5 would be the first SQLite-only SQL in the
codebase. When the Postgres swap happens, ``_apply_search`` is the one
function to move onto ``SearchVector``.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from django.db.models import Prefetch, Q, QuerySet
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from .models import EntityKind, Meeting, MeetingEntity

SNIPPET_RADIUS = 120
#: Where a snippet is looked for, most useful first.
_SNIPPET_FIELDS = ("transcript_md", "brief_md", "summary", "title")


def base_meeting_queryset() -> QuerySet[Meeting]:
    return Meeting.objects.select_related("project").prefetch_related(
        Prefetch(
            "entity_links",
            queryset=MeetingEntity.objects.select_related("entity__company").order_by(
                "role", "entity__name"
            ),
        ),
        "tags",
    )


def _entity_q(ref: Any, *, kind: str | None = None) -> Q:
    ref = str(ref)
    q = Q(entities__pk=int(ref)) if ref.isdigit() else Q(entities__slug=ref)
    if kind:
        q &= Q(entities__kind=kind)
    return q


def _day_bound(value: Any, *, end: bool) -> datetime | None:
    """Accept a date or datetime (object or ISO string); a bare date covers
    the whole day, so ``date_to=2026-09-16`` includes that day's meetings."""
    if isinstance(value, str):
        # Date first: parse_datetime happily reads "2026-09-16" as midnight,
        # which would turn an inclusive end day into an exclusive one.
        value = parse_date(value) if len(value) == 10 else parse_datetime(value)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if timezone.is_aware(value) else timezone.make_aware(value)
    if isinstance(value, date):
        day = value + timedelta(days=1) if end else value
        return timezone.make_aware(datetime.combine(day, time.min))
    return None


def _apply_search(qs: QuerySet[Meeting], term: str) -> QuerySet[Meeting]:
    return qs.filter(
        Q(title__icontains=term)
        | Q(summary__icontains=term)
        | Q(brief_md__icontains=term)
        | Q(transcript_md__icontains=term)
        | Q(entities__name__icontains=term)
        | Q(tags__name__icontains=term)
        | Q(key__iexact=term)
    )


def apply_meeting_filters(
    qs: QuerySet[Meeting], filters: dict[str, Any] | None
) -> QuerySet[Meeting]:
    filters = filters or {}

    project = filters.get("project")
    if project not in (None, ""):
        project = str(project)
        if project == "none":
            qs = qs.filter(project__isnull=True)
        elif project.isdigit():
            qs = qs.filter(project_id=int(project))
        else:
            qs = qs.filter(project__prefix__iexact=project)

    if filters.get("category"):
        qs = qs.filter(category=filters["category"])
    if filters.get("entity"):
        qs = qs.filter(_entity_q(filters["entity"]))
    if filters.get("person"):
        qs = qs.filter(_entity_q(filters["person"], kind=EntityKind.PERSON))
    if filters.get("company"):
        # A company's meetings include those its people attended, even when
        # the company itself wasn't tagged on the meeting.
        ref = str(filters["company"])
        own = _entity_q(ref, kind=EntityKind.COMPANY)
        via_people = (
            Q(entities__company__pk=int(ref))
            if ref.isdigit()
            else Q(entities__company__slug=ref)
        )
        qs = qs.filter(own | via_people)
    if filters.get("tag"):
        qs = qs.filter(tags__name=str(filters["tag"]).strip().lower())

    start = _day_bound(filters.get("date_from"), end=False)
    if start:
        qs = qs.filter(started_at__gte=start)
    end = _day_bound(filters.get("date_to"), end=True)
    if end:
        qs = qs.filter(started_at__lt=end)

    term = (filters.get("search") or "").strip()
    if term:
        qs = _apply_search(qs, term)

    # Every join above can fan out rows.
    return qs.distinct()


#: Large text columns that lists, the timeline and the graph never read.
BODY_FIELDS = ("transcript_md", "brief_md", "brief_html")


def filter_meetings(
    filters: dict[str, Any] | None = None, *, light: bool = False
) -> QuerySet[Meeting]:
    """``light=True`` skips loading the bodies — unless there's a search
    term, because the snippet is cut from them."""
    qs = apply_meeting_filters(base_meeting_queryset(), filters).order_by(
        "-started_at", "-id"
    )
    if light and not ((filters or {}).get("search") or "").strip():
        qs = qs.defer(*BODY_FIELDS)
    return qs


def search_snippet(meeting: Meeting, term: str) -> str:
    """The text around the first hit, so a result can show *why* it matched."""
    term = (term or "").strip()
    if not term:
        return ""
    needle = term.lower()
    for field in _SNIPPET_FIELDS:
        text = getattr(meeting, field) or ""
        at = text.lower().find(needle)
        if at < 0:
            continue
        start = max(0, at - SNIPPET_RADIUS)
        end = min(len(text), at + len(term) + SNIPPET_RADIUS)
        snippet = " ".join(text[start:end].split())
        return f"{'…' if start else ''}{snippet}{'…' if end < len(text) else ''}"
    return ""
