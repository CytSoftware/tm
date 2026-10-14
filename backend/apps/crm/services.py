"""Write-side logic for the CRM, shared by the REST API and the MCP tools.

Every write path ends in a broadcast (``broadcast_crm_event``). What they need
next is a task, so filing or ticking one also runs the normal task side
effects (transition log, board broadcast, notifications).
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from django.utils.dateparse import parse_date

from apps.meetings.models import Entity, EntityEmail, EntityKind
from apps.meetings.services import entity_slug, resolve_entity
from apps.tasks.broadcast import broadcast_task_event
from apps.tasks.models import (
    Column,
    ColumnKind,
    Project,
    Task,
    TransitionEvent,
    TransitionSource,
)
from apps.tasks.notifications import notify_task_event
from apps.tasks.transitions import record_transition

from .broadcast import broadcast_crm_event
from .models import CLOSED_STAGES, Lead, LeadStage, Update

DEFAULT_TZ = "Asia/Qatar"
#: A next step is due at this local time on its day.
DEFAULT_DUE_TIME = time(9, 0)

CONTACT_FIELDS = ("position", "phone", "linkedin_url", "website", "wiki_slug")
LEAD_FIELDS = ("title", "company", "project", "notes", "lost_reason")
UPDATE_FIELDS = ("kind", "body", "occurred_at")

#: "Argument not passed" — distinct from ``None``, which means "clear it".
UNSET: Any = object()


class CrmError(ValueError):
    """A write was refused for a reason the caller should be told about."""


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def resolve_tz(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)


def parse_day(value: Any) -> date | None:
    """A due date (``2026-10-19``); ``None`` / empty means none."""
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    parsed = parse_date(str(value).strip()[:10])
    if parsed is None:
        raise CrmError(f"Can't read {value!r} as a date (use 2026-10-19).")
    return parsed


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------


def resolve_project(ref: Any) -> Project:
    """A project by instance, id, prefix or name ("MOW", "mowafeq", 3)."""
    if isinstance(ref, Project):
        return ref
    text = str(ref or "").strip()
    project = (
        Project.objects.filter(pk=int(text)).first()
        if text.isdigit()
        else Project.objects.filter(prefix__iexact=text).first()
        or Project.objects.filter(name__iexact=text).first()
    )
    if project is None:
        raise CrmError(f"No project {ref!r}.")
    return project


def _resolve_company(value: Any) -> Entity | None:
    """An id, an ``Entity``, or a name (created if new)."""
    if value in (None, ""):
        return None
    if isinstance(value, Entity):
        company = value
    elif str(value).isdigit():
        company = Entity.objects.filter(pk=int(value)).first()
        if company is None:
            raise CrmError(f"No company with id {value}.")
    else:
        company = resolve_entity(EntityKind.COMPANY, str(value))
    if company.kind != EntityKind.COMPANY:
        raise CrmError(f"{company.name} is a person, not a company.")
    return company


# ---------------------------------------------------------------------------
# People & companies
# ---------------------------------------------------------------------------


def _clean_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if "@" not in email:
        raise CrmError(f"{raw!r} is not an email address.")
    return email


def set_emails(entity: Entity, emails: Iterable[str], *, replace: bool = True) -> None:
    """Give ``entity`` these addresses. An address already on someone else is
    refused rather than moved — that is usually a typo or a shared inbox."""
    wanted: list[str] = []
    for raw in emails:
        email = _clean_email(raw)
        if email not in wanted:
            wanted.append(email)
    clash = (
        EntityEmail.objects.filter(email__in=wanted)
        .exclude(entity=entity)
        .select_related("entity")
        .first()
    )
    if clash is not None:
        raise CrmError(f"{clash.email} already belongs to {clash.entity.name}.")
    if replace:
        entity.emails.exclude(email__in=wanted).delete()
    have = set(entity.emails.values_list("email", flat=True))
    for email in wanted:
        if email not in have:
            EntityEmail.objects.create(entity=entity, email=email)


@transaction.atomic
def update_contact(entity: Entity, data: dict[str, Any]) -> Entity:
    """Apply contact fields. ``emails`` replaces the set, ``add_emails`` adds.
    ``company`` takes an id or a name (created if new) and only applies to
    people. A rename keeps the old name as an alias."""
    for field in CONTACT_FIELDS:
        if data.get(field) is not None:
            setattr(entity, field, data[field])
    new_name = (data.get("name") or "").strip()
    if new_name and new_name != entity.name:
        # Same rule as meetings' update_meeting_entity: the slug follows the
        # new name — resolution is slug-then-alias, so a stale slug would make
        # the next recording under the new name create a duplicate.
        slug = entity_slug(new_name)
        clash = Entity.objects.filter(kind=entity.kind, slug=slug).exclude(pk=entity.pk).first()
        if clash is not None:
            raise CrmError(
                f"{new_name!r} already exists (id {clash.pk}) — merge them instead of renaming."
            )
        if entity.name not in entity.aliases:
            entity.aliases = [*entity.aliases, entity.name]
        entity.name, entity.slug = new_name, slug
    if "company" in data:
        if entity.kind != EntityKind.PERSON and data["company"] not in (None, ""):
            raise CrmError("Only a person can belong to a company.")
        entity.company = _resolve_company(data["company"])
    entity.save()

    if data.get("emails") is not None:
        set_emails(entity, data["emails"], replace=True)
    if data.get("add_emails"):
        set_emails(entity, data["add_emails"], replace=False)

    broadcast_crm_event("contact.updated", {"id": entity.id})
    return entity


@transaction.atomic
def create_contact(data: dict[str, Any]) -> tuple[Entity, bool]:
    """Find-or-create by name (slug, then aliases — same as meeting ingest, so
    a contact added here is the one the next recording lands on), then apply
    the fields. Returns ``(entity, created)``."""
    kind = data.get("kind") or EntityKind.PERSON
    name = (data.get("name") or "").strip()
    if not name:
        raise CrmError("A contact needs a name.")
    before = Entity.objects.filter(kind=kind).count()
    entity = resolve_entity(kind, name)
    created = Entity.objects.filter(kind=kind).count() > before
    fields = {k: v for k, v in data.items() if k not in ("kind", "name")}
    if not created:
        # The name matched someone we already know: blank form fields must
        # not wipe what they have, and emails add to the existing set.
        fields = {k: v for k, v in fields.items() if v not in (None, "", [])}
        if "emails" in fields:
            fields["add_emails"] = fields.pop("emails")
    update_contact(entity, fields)
    return entity, created


# ---------------------------------------------------------------------------
# Next steps (tasks filed by an update)
# ---------------------------------------------------------------------------


def _column(project: Project, *kinds: str) -> Column:
    for kind in kinds:
        col = project.columns.filter(kind=kind).order_by("order").first()
        if col is not None:
            return col
    col = project.columns.order_by("order").first()
    if col is None:
        raise CrmError(f"Project {project.prefix} has no columns.")
    return col


def _bottom_position(column: Column) -> float:
    current = column.tasks.aggregate(m=Max("position"))["m"]
    return (current or 0) + 1000.0


def _file_step(
    lead: Lead | None, title: str, *, user, due: Any, assignee, source: str, tz: str | None
) -> Task:
    """The task behind "what they need next": in the lead's project, Todo,
    assigned to ``assignee`` or else the author."""
    if lead is None:
        raise CrmError("What they need next is filed on a lead — pick one.")
    if lead.project_id is None:
        raise CrmError(f"Set {lead.key}'s project first — the next step is a task in it.")
    if not getattr(user, "is_authenticated", False):
        # Task.reporter is required; an unattributed credential can't file one.
        raise CrmError("Filing a next step needs an identified user.")
    day = parse_day(due)
    column = _column(lead.project, ColumnKind.TODO, ColumnKind.BACKLOG)
    task = Task(
        project=lead.project,
        column=column,
        title=title.strip()[:300],
        reporter=user,
        due_at=datetime.combine(day, DEFAULT_DUE_TIME, tzinfo=resolve_tz(tz)) if day else None,
        position=_bottom_position(column),
    )
    task.save()
    task.assignees.set([assignee or user])
    record_transition(
        task,
        from_column=None,
        to_column=column,
        event_type=TransitionEvent.CREATED,
        user=user,
        source=source,
    )
    broadcast_task_event(task.project_id, "task.created", {"key": task.key, "id": task.id})
    notify_task_event(task, user, "assigned")
    return task


@transaction.atomic
def set_step_done(task: Task, done: bool, *, user, source: str = TransitionSource.USER) -> Task:
    """Tick a next step off (into Done) or reopen it (back to Todo)."""
    column = (
        _column(task.project, ColumnKind.DONE)
        if done
        else _column(task.project, ColumnKind.TODO, ColumnKind.BACKLOG)
    )
    old = task.column
    if old is None or old.pk != column.pk:
        task.column = column
        task.position = _bottom_position(column)
        task.save(update_fields=["column", "position", "updated_at"])
        record_transition(
            task,
            from_column=old,
            to_column=column,
            event_type=TransitionEvent.MOVED,
            user=user,
            source=source,
        )
        broadcast_task_event(
            task.project_id, "task.moved", {"key": task.key, "id": task.id, "column_id": column.id}
        )
        notify_task_event(
            task,
            user,
            "completed" if column.is_done else "moved",
            payload={"from_column": old.name if old else None, "to_column": column.name},
        )
    broadcast_crm_event("update.updated", {"task": task.key})
    return task


# ---------------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------------


def _check_update(update: Update, people_count: int) -> None:
    if timezone.is_naive(update.occurred_at):
        raise CrmError("occurred_at must include a UTC offset.")
    if not (update.body or "").strip():
        raise CrmError("An update needs some text.")
    if update.lead_id is None and people_count == 0:
        raise CrmError("An update needs a lead or at least one person.")


def _announce_update(event: str, update: Update) -> None:
    broadcast_crm_event(
        event, {"id": update.id, "lead": update.lead.key if update.lead_id else None}
    )


@transaction.atomic
def post_update(
    data: dict[str, Any],
    *,
    user,
    lead: Lead | None = None,
    people: list[Entity] = (),
    users: list = (),
    meeting=None,
) -> Update:
    """Add an entry to a lead's thread. ``occurred_at`` defaults to the linked
    meeting's start, else now. ``next_step`` (with ``next_due`` /
    ``next_assignee``) files what they need next as a task linked to this
    update."""
    occurred_at = data.get("occurred_at") or (meeting.started_at if meeting else timezone.now())
    update = Update(
        lead=lead,
        kind=data.get("kind") or ("meeting" if meeting else "note"),
        body=(data.get("body") or "").strip(),
        occurred_at=occurred_at,
        meeting=meeting,
        created_by=user if getattr(user, "is_authenticated", False) else None,
    )
    _check_update(update, len(people))
    step = (data.get("next_step") or "").strip()
    if step:
        update.task = _file_step(
            lead,
            step,
            user=user,
            due=data.get("next_due"),
            assignee=data.get("next_assignee"),
            source=data.get("transition_source") or TransitionSource.USER,
            tz=data.get("tz"),
        )
    update.save()
    update.people.set(people)
    update.users.set(users)
    _announce_update("update.created", update)
    return update


@transaction.atomic
def edit_update(
    update: Update,
    data: dict[str, Any],
    *,
    lead: Any = UNSET,
    people: list[Entity] | None = None,
    users: list | None = None,
    meeting: Any = UNSET,
) -> Update:
    """Correct an update. Lists replace; ``lead=None`` / ``meeting=None``
    unlink, omitting them leaves the link alone."""
    for field in UPDATE_FIELDS:
        if data.get(field) is not None:
            setattr(update, field, data[field])
    if lead is not UNSET:
        update.lead = lead
    if meeting is not UNSET:
        update.meeting = meeting
    if people is not None:
        update.people.set(people)
    _check_update(update, update.people.count())
    update.save()
    if users is not None:
        update.users.set(users)
    _announce_update("update.updated", update)
    return update


def delete_update(update: Update) -> None:
    lead_key = update.lead.key if update.lead_id else None
    update_id = update.id
    update.delete()
    broadcast_crm_event("update.deleted", {"id": update_id, "lead": lead_key})


# ---------------------------------------------------------------------------
# Leads
# ---------------------------------------------------------------------------


def _check_lead(lead: Lead) -> None:
    if not (lead.title or "").strip():
        raise CrmError("A lead needs a title.")
    if lead.stage not in LeadStage.values:
        raise CrmError(f"Unknown stage {lead.stage!r}; use one of: {', '.join(LeadStage.values)}.")
    if lead.company is not None and lead.company.kind != EntityKind.COMPANY:
        raise CrmError(f"{lead.company.name} is a person, not a company.")


def _sync_closed(lead: Lead, previous_stage: str | None) -> None:
    now_closed = lead.stage in CLOSED_STAGES
    if now_closed and previous_stage not in CLOSED_STAGES:
        lead.closed_at = timezone.now()
    elif not now_closed:
        lead.closed_at = None
        lead.lost_reason = ""


def _position_in(stage: str, index: int | None, *, exclude: int | None = None) -> float:
    """Midpoint position for slot ``index`` in ``stage`` (``None`` = bottom)."""
    siblings = list(
        Lead.objects.filter(stage=stage)
        .exclude(pk=exclude)
        .order_by("position", "id")
        .values_list("position", flat=True)
    )
    if not siblings:
        return 1000.0
    if index is None or index >= len(siblings):
        return siblings[-1] + 1000.0
    if index <= 0:
        return siblings[0] - 1000.0
    return (siblings[index - 1] + siblings[index]) / 2


@transaction.atomic
def create_lead(data: dict[str, Any], *, user) -> Lead:
    lead = Lead(
        stage=data.get("stage") or LeadStage.NEW,
        created_by=user if getattr(user, "is_authenticated", False) else None,
        **{f: data[f] for f in LEAD_FIELDS if data.get(f) is not None},
    )
    _check_lead(lead)
    lead.position = _position_in(lead.stage, None)
    _sync_closed(lead, None)
    lead.save()
    broadcast_crm_event("lead.created", {"key": lead.key})
    return lead


@transaction.atomic
def update_lead(lead: Lead, data: dict[str, Any]) -> Lead:
    previous_stage = lead.stage
    for field in LEAD_FIELDS:
        if field in data:
            setattr(lead, field, data[field])
    if data.get("stage") and data["stage"] != lead.stage:
        lead.stage = data["stage"]
        lead.position = _position_in(lead.stage, None, exclude=lead.pk)
    _check_lead(lead)
    _sync_closed(lead, previous_stage)
    lead.save()
    broadcast_crm_event("lead.updated", {"key": lead.key})
    return lead


@transaction.atomic
def move_lead(lead: Lead, stage: str, *, index: int | None = None) -> Lead:
    """Drag-and-drop: into ``stage`` at slot ``index``."""
    if stage not in LeadStage.values:
        raise CrmError(f"Unknown stage {stage!r}.")
    previous_stage = lead.stage
    lead.position = _position_in(stage, index, exclude=lead.pk)
    lead.stage = stage
    _sync_closed(lead, previous_stage)
    lead.save()
    broadcast_crm_event("lead.moved", {"key": lead.key, "stage": stage})
    return lead


def delete_lead(lead: Lead) -> None:
    key = lead.key
    lead.delete()
    broadcast_crm_event("lead.deleted", {"key": key})
