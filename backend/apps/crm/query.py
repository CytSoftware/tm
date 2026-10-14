"""Single source of truth for CRM filtering, sorting and derived facts.

Same contract as :mod:`apps.tasks.query` / :mod:`apps.meetings.query`: the DRF
views and the MCP tools all go through these helpers — don't reimplement a
filter in either. Unknown filter keys are ignored.

Derived, never stored: whether an entity is "in the CRM", its last update,
and a lead's next step (the soonest open task its updates filed) are query
annotations, so none of them can drift.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.db.models import (
    Count,
    F,
    IntegerField,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
)
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.meetings.models import Entity
from apps.tasks.models import ColumnKind, Project, Task

from .models import CLOSED_STAGES, Lead, Update

#: Task columns that mean a next step is no longer owed.
CLOSED_COLUMN_KINDS = (ColumnKind.DONE, ColumnKind.CANCELLED)

#: A company is in the CRM once it has a lead (or a tagged employee); a person
#: once an update tags them or their company has a lead.
IN_CRM = (
    Q(leads__isnull=False)
    | Q(crm_updates__isnull=False)
    | Q(company__leads__isnull=False)
    | Q(people__crm_updates__isnull=False)
)


def project_id(value: Any) -> int | None:
    """The CRM scope filter: a project id, prefix or name ("MOW", "mowafeq").
    Blank → no scope (None); unknown → -1, which matches nothing rather than
    silently showing everything."""
    text = str(value or "").strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)
    pk = (
        Project.objects.filter(Q(prefix__iexact=text) | Q(name__iexact=text))
        .values_list("pk", flat=True)
        .first()
    )
    return pk if pk is not None else -1


def _id(value: Any) -> int | None:
    text = str(value or "").strip()
    return int(text) if text.isdigit() else None


# ---------------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------------


def about_entity(entity_id: Any) -> Q:
    """Updates that concern an entity: it is tagged, it employs someone
    tagged, or the update is on its lead."""
    return Q(people=entity_id) | Q(people__company=entity_id) | Q(lead__company=entity_id)


def base_update_queryset() -> QuerySet[Update]:
    return Update.objects.select_related(
        "lead__company", "meeting", "created_by", "task__column"
    ).prefetch_related("people__company", "users", "task__assignees")


def filter_updates(filters: dict[str, Any] | None = None) -> QuerySet[Update]:
    """``{lead, entity, project, days}``. ``lead`` is a key."""
    filters = filters or {}
    qs = base_update_queryset()
    if filters.get("lead"):
        qs = qs.filter(lead__key__iexact=str(filters["lead"]))
    entity = _id(filters.get("entity"))
    if entity is not None:
        qs = qs.filter(about_entity(entity))
    pid = project_id(filters.get("project"))
    if pid is not None:
        qs = qs.filter(lead__project_id=pid)
    days = _id(filters.get("days"))
    if days:
        qs = qs.filter(occurred_at__gte=timezone.now() - timedelta(days=days))
    # Joins through people repeat a row once per matching person; re-selecting
    # by id from a fresh, unjoined queryset drops the repeats and stays
    # sliceable and portable (no DISTINCT ON).
    return base_update_queryset().filter(pk__in=qs.values("pk")).order_by("-occurred_at", "-id")


# ---------------------------------------------------------------------------
# People & companies
# ---------------------------------------------------------------------------


def annotate_contacts(qs: QuerySet[Entity]) -> QuerySet[Entity]:
    last = Update.objects.filter(about_entity(OuterRef("pk"))).order_by("-occurred_at")
    return qs.annotate(
        last_update_at=Subquery(last.values("occurred_at")[:1]),
        last_update_body=Subquery(last.values("body")[:1]),
        last_update_kind=Subquery(last.values("kind")[:1]),
        people_count=Coalesce(
            Subquery(
                Entity.objects.filter(company_id=OuterRef("pk"))
                .values("company_id")
                .annotate(n=Count("pk"))
                .values("n")[:1],
                output_field=IntegerField(),
            ),
            0,
        ),
        open_lead_count=Coalesce(
            Subquery(
                Lead.objects.filter(company_id=OuterRef("pk"))
                .exclude(stage__in=CLOSED_STAGES)
                .values("company_id")
                .annotate(n=Count("pk"))
                .values("n")[:1],
                output_field=IntegerField(),
            ),
            0,
        ),
    )


def base_contact_queryset() -> QuerySet[Entity]:
    return annotate_contacts(Entity.objects.select_related("company").prefetch_related("emails"))


def filter_contacts(filters: dict[str, Any] | None = None) -> QuerySet[Entity]:
    """``{kind, company, search, project, all}``. Defaults to entities in the
    CRM; a search (or ``all``) looks through every person and company we know,
    so someone met once in a meeting can still be found and tagged."""
    filters = filters or {}
    qs = Entity.objects.all()
    term = (filters.get("search") or "").strip()
    if not term and str(filters.get("all") or "").lower() not in ("1", "true", "yes"):
        qs = qs.filter(IN_CRM)
    if filters.get("kind"):
        qs = qs.filter(kind=filters["kind"])
    company = _id(filters.get("company"))
    if company is not None:
        qs = qs.filter(company_id=company)
    pid = project_id(filters.get("project"))
    if pid is not None:
        qs = qs.filter(
            Q(leads__project_id=pid)
            | Q(company__leads__project_id=pid)
            | Q(crm_updates__lead__project_id=pid)
            | Q(people__crm_updates__lead__project_id=pid)
        )
    if term:
        qs = qs.filter(
            Q(name__icontains=term)
            | Q(aliases__icontains=term)
            | Q(position__icontains=term)
            | Q(emails__email__icontains=term)
            | Q(company__name__icontains=term)
        )
    ids = qs.values("pk")
    return base_contact_queryset().filter(pk__in=ids).order_by(
        F("last_update_at").desc(nulls_last=True), "name"
    )


# ---------------------------------------------------------------------------
# Leads
# ---------------------------------------------------------------------------


def open_steps() -> QuerySet[Task]:
    """Next steps still owed, soonest first (undated last)."""
    return (
        Task.objects.filter(crm_update__isnull=False)
        .exclude(column__kind__in=CLOSED_COLUMN_KINDS)
        .order_by(F("due_at").asc(nulls_last=True), "created_at", "id")
    )


def base_lead_queryset() -> QuerySet[Lead]:
    step = open_steps().filter(crm_update__lead_id=OuterRef("pk"))
    last = Update.objects.filter(lead_id=OuterRef("pk")).order_by("-occurred_at", "-id")
    return Lead.objects.select_related("company", "project").annotate(
        next_step_key=Subquery(step.values("key")[:1]),
        next_step_title=Subquery(step.values("title")[:1]),
        next_step_due=Subquery(step.values("due_at")[:1]),
        last_update_at=Subquery(last.values("occurred_at")[:1]),
    )


def filter_leads(filters: dict[str, Any] | None = None) -> QuerySet[Lead]:
    """``{stage, status, entity, project, search}``. ``status``: open, won,
    lost, closed. ``entity`` matches the lead's company, or — for a person —
    leads they're tagged on and their employer's leads."""
    filters = filters or {}
    qs = Lead.objects.all()
    if filters.get("stage"):
        qs = qs.filter(stage=filters["stage"])
    status = (filters.get("status") or "").lower()
    if status == "open":
        qs = qs.exclude(stage__in=CLOSED_STAGES)
    elif status in CLOSED_STAGES:
        qs = qs.filter(stage=status)
    elif status == "closed":
        qs = qs.filter(stage__in=CLOSED_STAGES)
    entity = _id(filters.get("entity"))
    if entity is not None:
        qs = qs.filter(
            Q(company_id=entity) | Q(updates__people=entity) | Q(company__people=entity)
        )
    pid = project_id(filters.get("project"))
    if pid is not None:
        qs = qs.filter(project_id=pid)
    term = (filters.get("search") or "").strip()
    if term:
        qs = qs.filter(
            Q(title__icontains=term) | Q(key__iexact=term) | Q(company__name__icontains=term)
        )
    return base_lead_queryset().filter(pk__in=qs.values("pk")).order_by("position", "id")


def lead_people(lead: Lead) -> QuerySet[Entity]:
    """Everyone tagged on the lead's thread, by name."""
    return (
        Entity.objects.filter(crm_updates__lead=lead)
        .select_related("company")
        .distinct()
        .order_by("name")
    )
