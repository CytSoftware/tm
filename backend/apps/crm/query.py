"""Single source of truth for CRM filtering, sorting and derived dates.

Same contract as :mod:`apps.tasks.query` / :mod:`apps.meetings.query`: the DRF
viewsets and the MCP tools all go through ``filter_contacts`` /
``filter_deals`` — don't reimplement a filter in either. Unknown filter keys
are ignored.

``last_contact_at`` and ``next_follow_up_at`` are **annotations, not stored
columns**, so they can't drift from the meetings, touchpoints and tasks they
summarise. A company's dates include its people's activity.

Contact filter dict::

    {relationship, kind, owner, company, search, no_next_step, overdue}

``relationship`` defaults to "in the CRM" (set, and not ``internal``); pass a
comma list (``lead,client``) to narrow, or ``any`` for every entity.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone as dt_timezone
from typing import Any

from django.db.models import (
    DateTimeField,
    Exists,
    F,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    Value,
)
from django.db.models.functions import Coalesce, Greatest
from django.utils import timezone

from apps.meetings.models import Entity, EntityRole, Meeting, RelationshipType
from apps.tasks.models import ColumnKind

from .models import Deal, FollowUp, StageKind, Touchpoint

#: Stand-in for "never" inside ``Greatest`` — portable, unlike relying on how
#: each database's GREATEST treats NULL (SQLite returns NULL, Postgres skips
#: it). Converted back to ``None`` by :func:`real_date`.
EPOCH = datetime(1970, 1, 1, tzinfo=dt_timezone.utc)

#: Task columns that mean a follow-up is no longer owed.
CLOSED_COLUMN_KINDS = (ColumnKind.DONE, ColumnKind.CANCELLED)

OPEN_FOLLOW_UP = ~Q(task__column__kind__in=CLOSED_COLUMN_KINDS)

#: Entities that count as "in the CRM" by default.
CRM_RELATIONSHIPS = tuple(
    value for value, _ in RelationshipType.choices if value != RelationshipType.INTERNAL
)


def real_date(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return None if value <= EPOCH else value


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------


def _for_entity_or_people(prefix: str) -> Q:
    """``<prefix>`` is the entity itself, or — for a company — one of its people."""
    return Q(**{f"{prefix}__id": OuterRef("pk")}) | Q(
        **{f"{prefix}__company_id": OuterRef("pk")}
    )


def _open_follow_ups() -> QuerySet[FollowUp]:
    return FollowUp.objects.filter(OPEN_FOLLOW_UP).filter(_for_entity_or_people("entity"))


def annotate_contacts(qs: QuerySet[Entity]) -> QuerySet[Entity]:
    last_meeting = Meeting.objects.filter(
        Q(entity_links__entity_id=OuterRef("pk"))
        | Q(entity_links__entity__company_id=OuterRef("pk")),
        entity_links__role=EntityRole.ATTENDEE,
    ).order_by("-started_at")
    last_touch = Touchpoint.objects.filter(_for_entity_or_people("entities")).order_by(
        "-occurred_at"
    )
    next_due = (
        _open_follow_ups()
        .filter(task__due_at__isnull=False)
        .order_by("task__due_at")
    )
    epoch = Value(EPOCH, output_field=DateTimeField())
    return qs.annotate(
        last_meeting_at=Subquery(last_meeting.values("started_at")[:1]),
        last_meeting_title=Subquery(last_meeting.values("title")[:1]),
        last_touch_at=Subquery(last_touch.values("occurred_at")[:1]),
        last_touch_summary=Subquery(last_touch.values("summary")[:1]),
        last_touch_kind=Subquery(last_touch.values("kind")[:1]),
    ).annotate(
        last_contact_at=Greatest(
            Coalesce(F("last_meeting_at"), epoch),
            Coalesce(F("last_touch_at"), epoch),
            output_field=DateTimeField(),
        ),
        next_follow_up_at=Subquery(next_due.values("task__due_at")[:1]),
        next_follow_up_title=Subquery(next_due.values("task__title")[:1]),
        has_open_follow_up=Exists(_open_follow_ups()),
    )


def last_activity(entity: Entity) -> dict[str, Any] | None:
    """The newest of the annotated meeting / touchpoint, for list rows."""
    meeting_at = getattr(entity, "last_meeting_at", None)
    touch_at = getattr(entity, "last_touch_at", None)
    if meeting_at is None and touch_at is None:
        return None
    if touch_at is None or (meeting_at is not None and meeting_at >= touch_at):
        return {"type": "meeting", "at": meeting_at, "text": entity.last_meeting_title}
    return {
        "type": "touchpoint",
        "kind": entity.last_touch_kind,
        "at": touch_at,
        "text": entity.last_touch_summary,
    }


def base_contact_queryset() -> QuerySet[Entity]:
    return annotate_contacts(
        Entity.objects.select_related("company", "owner").prefetch_related("emails")
    )


def _relationship_q(value: Any) -> Q | None:
    raw = str(value or "").strip().lower()
    if raw == "any":
        return None
    if not raw:
        return Q(relationship__in=CRM_RELATIONSHIPS)
    wanted = [v.strip() for v in raw.split(",") if v.strip()]
    return Q(relationship__in=wanted)


def apply_contact_filters(
    qs: QuerySet[Entity], filters: dict[str, Any] | None
) -> QuerySet[Entity]:
    filters = filters or {}

    rel_q = _relationship_q(filters.get("relationship"))
    if rel_q is not None:
        qs = qs.filter(rel_q)

    if filters.get("kind"):
        qs = qs.filter(kind=filters["kind"])

    owner = filters.get("owner")
    if owner not in (None, ""):
        owner = str(owner)
        if owner == "none":
            qs = qs.filter(owner__isnull=True)
        elif owner.isdigit():
            qs = qs.filter(owner_id=int(owner))
        else:
            qs = qs.filter(owner__username__iexact=owner)

    company = filters.get("company")
    if company not in (None, ""):
        company = str(company)
        qs = (
            qs.filter(company_id=int(company))
            if company.isdigit()
            else qs.filter(company__slug=company)
        )

    term = (filters.get("search") or "").strip()
    if term:
        qs = qs.filter(
            Q(name__icontains=term)
            | Q(aliases__icontains=term)
            | Q(headline__icontains=term)
            | Q(emails__email__icontains=term)
            | Q(company__name__icontains=term)
        )

    if _truthy(filters.get("no_next_step")):
        qs = qs.filter(has_open_follow_up=False)
    if _truthy(filters.get("overdue")):
        qs = qs.filter(next_follow_up_at__lt=timezone.now())

    return qs.distinct()


CONTACT_SORTS = {
    "last_contact": ("-last_contact_at", "name"),
    "next_follow_up": ("next_follow_up_at", "name"),
    "name": ("name",),
    "created": ("-created_at",),
}


def filter_contacts(
    filters: dict[str, Any] | None = None, *, sort: str | None = None
) -> QuerySet[Entity]:
    qs = apply_contact_filters(base_contact_queryset(), filters)
    order = CONTACT_SORTS.get(sort or "last_contact", CONTACT_SORTS["last_contact"])
    if order[0] == "next_follow_up_at":
        # Undated / no follow-up last, portable across SQLite and Postgres.
        return qs.order_by(F("next_follow_up_at").asc(nulls_last=True), "name")
    return qs.order_by(*order)


# ---------------------------------------------------------------------------
# Deals
# ---------------------------------------------------------------------------


def base_deal_queryset() -> QuerySet[Deal]:
    return Deal.objects.select_related(
        "pipeline", "stage", "company", "owner", "product_project"
    ).prefetch_related("contacts")


def apply_deal_filters(qs: QuerySet[Deal], filters: dict[str, Any] | None) -> QuerySet[Deal]:
    filters = filters or {}

    pipeline = filters.get("pipeline")
    if pipeline not in (None, ""):
        pipeline = str(pipeline)
        qs = (
            qs.filter(pipeline_id=int(pipeline))
            if pipeline.isdigit()
            else qs.filter(pipeline__slug=pipeline)
        )
    if filters.get("stage"):
        qs = qs.filter(stage_id=int(filters["stage"]))

    status = (filters.get("status") or "").lower()
    if status == "open":
        qs = qs.filter(stage__kind=StageKind.OPEN)
    elif status in (StageKind.WON, StageKind.LOST):
        qs = qs.filter(stage__kind=status)
    elif status == "closed":
        qs = qs.exclude(stage__kind=StageKind.OPEN)

    entity = filters.get("entity")
    if entity not in (None, ""):
        entity_id = int(entity)
        qs = qs.filter(
            Q(company_id=entity_id)
            | Q(contacts__id=entity_id)
            | Q(company__people__id=entity_id)
        )

    owner = filters.get("owner")
    if owner not in (None, ""):
        owner = str(owner)
        qs = (
            qs.filter(owner_id=int(owner))
            if owner.isdigit()
            else qs.filter(owner__username__iexact=owner)
        )

    term = (filters.get("search") or "").strip()
    if term:
        qs = qs.filter(
            Q(title__icontains=term)
            | Q(key__iexact=term)
            | Q(company__name__icontains=term)
            | Q(contacts__name__icontains=term)
        )
    return qs.distinct()


def filter_deals(filters: dict[str, Any] | None = None) -> QuerySet[Deal]:
    return apply_deal_filters(base_deal_queryset(), filters).order_by(
        "pipeline__position", "stage__position", "position", "id"
    )


# ---------------------------------------------------------------------------
# Follow-ups
# ---------------------------------------------------------------------------


def base_follow_up_queryset() -> QuerySet[FollowUp]:
    return FollowUp.objects.select_related(
        "task__column",
        "task__project",
        "entity__company",
        "deal",
    ).prefetch_related("task__assignees")


def open_follow_ups(filters: dict[str, Any] | None = None) -> QuerySet[FollowUp]:
    filters = filters or {}
    qs = base_follow_up_queryset().filter(OPEN_FOLLOW_UP)
    owner = filters.get("owner")
    if owner not in (None, ""):
        owner = str(owner)
        qs = (
            qs.filter(task__assignees__id=int(owner))
            if owner.isdigit()
            else qs.filter(task__assignees__username__iexact=owner)
        )
    if filters.get("entity"):
        qs = qs.filter(
            Q(entity_id=int(filters["entity"]))
            | Q(entity__company_id=int(filters["entity"]))
        )
    return qs.distinct().order_by(F("task__due_at").asc(nulls_last=True), "id")


def _truthy(value: Any) -> bool:
    return str(value).lower() in ("1", "true", "yes") if value is not None else False


#: Inbox sections, in display order.
BUCKETS = ("overdue", "today", "week", "later")


def bucket_follow_ups(follow_ups, tz) -> tuple[date, dict[str, list[FollowUp]]]:
    """Split open follow-ups into Overdue / Today / This week (next 7 days) /
    Later by their due date *in* ``tz``. Undated ones are Later."""
    today = timezone.now().astimezone(tz).date()
    week_end = today + timedelta(days=7)
    out: dict[str, list[FollowUp]] = {name: [] for name in BUCKETS}
    for f in follow_ups:
        due = f.task.due_at.astimezone(tz).date() if f.task.due_at else None
        if due is None or due > week_end:
            out["later"].append(f)
        elif due < today:
            out["overdue"].append(f)
        elif due == today:
            out["today"].append(f)
        else:
            out["week"].append(f)
    return today, out


def without_listed_companies_people(contacts) -> list:
    """Drop people whose company is already in ``contacts`` — the inbox's
    "no next step" list would otherwise show Sharq *and* Firoz for one gap."""
    rows = list(contacts)
    company_ids = {c.pk for c in rows if c.kind == "company"}
    return [c for c in rows if c.company_id not in company_ids]
