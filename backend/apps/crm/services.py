"""Write-side logic for the CRM, shared by the REST API and the MCP tools.

Every write path ends in a broadcast (``broadcast_crm_event``); the ones that
touch a follow-up task also run the normal task side effects (transition log,
board broadcast, notifications) so a follow-up is indistinguishable from any
other task to the rest of Task Manager.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from apps.meetings.models import Entity, EntityEmail, EntityKind, RelationshipType
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
from .models import (
    CrmSettings,
    Deal,
    FollowUp,
    Pipeline,
    Stage,
    StageKind,
    Touchpoint,
    TouchpointSource,
)

#: Where follow-ups live. ``FUP-012`` reads better than ``CRM-012``.
CRM_PROJECT_PREFIX = "FUP"
CRM_PROJECT_NAME = "CRM"
DEFAULT_TZ = "Asia/Qatar"
#: A follow-up given only a date is due at this local time.
DEFAULT_DUE_TIME = time(9, 0)

CONTACT_FIELDS = (
    "relationship",
    "headline",
    "phone",
    "whatsapp",
    "linkedin_url",
    "website",
    "wiki_slug",
)


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


def parse_due(value: Any, tz: str | None = None) -> datetime | None:
    """A date (``2026-10-08``) means 09:00 that day in ``tz``; a datetime must
    carry an offset. ``None`` / empty clears the due date."""
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed: date | datetime | None = value
    elif isinstance(value, date):
        parsed = value
    else:
        text = str(value).strip()
        parsed = parse_date(text) if len(text) == 10 else parse_datetime(text)
    if parsed is None:
        raise CrmError(f"Can't read {value!r} as a date (use 2026-10-08) or datetime.")
    if isinstance(parsed, datetime):
        if timezone.is_naive(parsed):
            raise CrmError(
                "A due time must include a UTC offset, e.g. 2026-10-08T10:00:00+03:00 "
                "— or pass just the date."
            )
        return parsed
    return datetime.combine(parsed, DEFAULT_DUE_TIME, tzinfo=resolve_tz(tz))


# ---------------------------------------------------------------------------
# CRM project
# ---------------------------------------------------------------------------


def crm_project() -> Project:
    """The project follow-ups live in, created on first use.

    Not a data migration on purpose: a ``Project``'s default columns are
    seeded by a ``post_save`` receiver, which doesn't fire for the historical
    models a migration sees.
    """
    settings_row, _ = CrmSettings.objects.get_or_create(pk=CrmSettings.SINGLETON_PK)
    if settings_row.project_id:
        return settings_row.project
    project = Project.objects.filter(prefix__iexact=CRM_PROJECT_PREFIX).first()
    if project is None:
        project = Project.objects.create(
            name=CRM_PROJECT_NAME,
            prefix=CRM_PROJECT_PREFIX,
            description="Follow-ups owed to contacts. Managed from /crm.",
            color="#0ea5e9",
            icon="🤝",
        )
    settings_row.project = project
    settings_row.save()
    return project


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


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------


def _clean_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if "@" not in email:
        raise CrmError(f"{raw!r} is not an email address.")
    return email


def set_emails(
    entity: Entity,
    emails: Iterable[str],
    *,
    replace: bool = True,
) -> None:
    """Give ``entity`` these addresses. An address already on someone else is
    refused rather than moved — that is usually a typo or a shared inbox."""
    wanted = []
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


@transaction.atomic
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


def tag_projects(entities: Iterable[Entity | None], *projects: Project | None) -> None:
    """Add projects to contacts — additive, never removes. A person's
    employer gets them too, so a company is in every scope its people are."""
    projects = tuple(p for p in projects if p is not None)
    if not projects:
        return
    seen: set[int] = set()
    for entity in entities:
        while entity is not None and entity.pk not in seen:
            seen.add(entity.pk)
            entity.projects.add(*projects)
            entity = entity.company if entity.kind == EntityKind.PERSON else None


def update_contact(entity: Entity, data: dict[str, Any]) -> Entity:
    """Apply CRM/contact fields. ``emails`` replaces the set;
    ``add_emails`` / ``remove_emails`` edit it. ``company`` takes an id or a
    name and only applies to people. ``projects`` (ids, prefixes or names)
    replaces the contact's scope; a person's projects also go on their
    company."""
    for field in CONTACT_FIELDS:
        if field in data and data[field] is not None:
            setattr(entity, field, data[field])
    new_name = (data.get("name") or "").strip()
    if new_name and new_name != entity.name:
        # Same rule as meetings' update_meeting_entity: the old spelling stays
        # an alias, and the slug follows the new name — resolution is
        # slug-then-alias, so a stale slug would make the next recording
        # under the new name create a duplicate.
        slug = entity_slug(new_name)
        clash = Entity.objects.filter(kind=entity.kind, slug=slug).exclude(pk=entity.pk).first()
        if clash is not None:
            raise CrmError(
                f"{new_name!r} already exists (id {clash.pk}) — merge them instead of renaming."
            )
        if entity.name not in entity.aliases:
            entity.aliases = [*entity.aliases, entity.name]
        entity.name, entity.slug = new_name, slug
    if "owner" in data:
        entity.owner = data["owner"]
    if "company" in data:
        if entity.kind != EntityKind.PERSON and data["company"] not in (None, ""):
            raise CrmError("Only a person can belong to a company.")
        entity.company = _resolve_company(data["company"])
    entity.save()

    # A CRM contact's employer belongs in the CRM too (it's what the
    # Companies tab lists); it takes the person's type until someone sets one.
    company = entity.company
    if company is not None and entity.relationship and not company.relationship:
        company.relationship = entity.relationship
        if company.owner_id is None:
            company.owner_id = entity.owner_id
        company.save(update_fields=["relationship", "owner", "updated_at"])

    if data.get("projects") is not None:
        entity.projects.set([resolve_project(p) for p in data["projects"]])
    if data.get("add_projects"):
        entity.projects.add(*[resolve_project(p) for p in data["add_projects"]])
    if data.get("remove_projects"):
        entity.projects.remove(*[resolve_project(p) for p in data["remove_projects"]])
    if company is not None:
        tag_projects([company], *entity.projects.all())

    if data.get("emails") is not None:
        set_emails(entity, data["emails"], replace=True)
    if data.get("add_emails"):
        set_emails(entity, data["add_emails"], replace=False)
    if data.get("remove_emails"):
        entity.emails.filter(
            email__in=[_clean_email(e) for e in data["remove_emails"]]
        ).delete()

    broadcast_crm_event("contact.updated", {"id": entity.id})
    return entity


@transaction.atomic
def create_contact(data: dict[str, Any]) -> tuple[Entity, bool]:
    """Find-or-create by name (slug, then aliases — same as meeting ingest, so
    a contact added here is the one the next recording lands on), then apply
    the CRM fields. Returns ``(entity, created)``."""
    kind = data.get("kind") or EntityKind.PERSON
    name = (data.get("name") or "").strip()
    if not name:
        raise CrmError("A contact needs a name.")
    before = Entity.objects.filter(kind=kind).count()
    entity = resolve_entity(kind, name)
    created = Entity.objects.filter(kind=kind).count() > before
    fields = {k: v for k, v in data.items() if k not in ("kind", "name")}
    if not fields.get("relationship") and not entity.relationship:
        fields["relationship"] = RelationshipType.LEAD
    update_contact(entity, fields)
    return entity, created


def find_by_emails(emails: Iterable[str]) -> dict[str, Entity]:
    """``{email: entity}`` for the addresses we know. Unknown ones are simply
    absent — ingest agents must not auto-create contacts from email."""
    cleaned = [e.strip().lower() for e in emails if e and "@" in e]
    rows = EntityEmail.objects.filter(email__in=cleaned).select_related(
        "entity__company"
    )
    return {row.email: row.entity for row in rows}


# ---------------------------------------------------------------------------
# Follow-ups
# ---------------------------------------------------------------------------


def _require_user(user) -> None:
    if not getattr(user, "is_authenticated", False):
        # Task.reporter is required; an unattributed credential can't file one.
        raise CrmError("Creating a follow-up needs an identified user.")


@transaction.atomic
def create_follow_up(
    entity: Entity,
    title: str,
    *,
    user,
    due: Any = None,
    tz: str | None = None,
    deal: Deal | None = None,
    assignee=None,
    description: str = "",
    source: str = TransitionSource.USER,
) -> Task:
    """A task in the CRM project, linked to ``entity`` (and ``deal``).
    Assigned to ``assignee``, else the contact's owner, else the caller."""
    _require_user(user)
    title = (title or "").strip()
    if not title:
        raise CrmError("A follow-up needs a title.")
    project = crm_project()
    column = _column(project, ColumnKind.TODO, ColumnKind.BACKLOG)
    task = Task(
        project=project,
        column=column,
        title=title[:300],
        description=description or "",
        reporter=user,
        due_at=parse_due(due, tz),
        position=_bottom_position(column),
    )
    task.save()
    who = assignee or entity.owner or user
    task.assignees.set([who])
    FollowUp.objects.create(task=task, entity=entity, deal=deal)

    record_transition(
        task,
        from_column=None,
        to_column=column,
        event_type=TransitionEvent.CREATED,
        user=user,
        source=source,
    )
    broadcast_task_event(project.id, "task.created", {"key": task.key, "id": task.id})
    notify_task_event(task, user, "assigned")
    notify_task_event(task, user, "created", recipients=[])
    broadcast_crm_event("follow_up.changed", {"entity": entity.id, "task": task.key})
    return task


def _move(task: Task, column: Column, *, user, source: str) -> None:
    old = task.column
    if old is not None and old.pk == column.pk:
        return
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
        task.project_id,
        "task.moved",
        {"key": task.key, "id": task.id, "column_id": column.id},
    )
    notify_task_event(
        task,
        user,
        "completed" if column.is_done else "moved",
        payload={"from_column": old.name if old else None, "to_column": column.name},
    )


@transaction.atomic
def complete_follow_up(
    follow_up: FollowUp, *, user, source: str = TransitionSource.USER
) -> FollowUp:
    task = follow_up.task
    _move(task, _column(task.project, ColumnKind.DONE), user=user, source=source)
    broadcast_crm_event(
        "follow_up.changed", {"entity": follow_up.entity_id, "task": task.key}
    )
    return follow_up


@transaction.atomic
def reopen_follow_up(
    follow_up: FollowUp, *, user, source: str = TransitionSource.USER
) -> FollowUp:
    task = follow_up.task
    _move(
        task,
        _column(task.project, ColumnKind.TODO, ColumnKind.BACKLOG),
        user=user,
        source=source,
    )
    broadcast_crm_event(
        "follow_up.changed", {"entity": follow_up.entity_id, "task": task.key}
    )
    return follow_up


@transaction.atomic
def reschedule_follow_up(
    follow_up: FollowUp, due: Any, *, user, tz: str | None = None
) -> FollowUp:
    task = follow_up.task
    task.due_at = parse_due(due, tz)
    task.save(update_fields=["due_at", "updated_at"])
    broadcast_task_event(task.project_id, "task.updated", {"key": task.key, "id": task.id})
    broadcast_crm_event(
        "follow_up.changed", {"entity": follow_up.entity_id, "task": task.key}
    )
    return follow_up


# ---------------------------------------------------------------------------
# Touchpoints
# ---------------------------------------------------------------------------


@transaction.atomic
def log_touchpoint(
    data: dict[str, Any],
    entities: list[Entity],
    *,
    user,
    deal: Deal | None = None,
) -> tuple[Touchpoint, bool, Task | None]:
    """Record an interaction. Upserts on ``(source, external_id)`` when an
    external id is given, so an agent can re-push the same email safely; on
    a re-push the entity links are additive.

    ``data["follow_up"]`` (``{title, due, assignee}``) also files a follow-up
    against the first entity — the "he'll send drawings Thursday" case.
    """
    if not entities:
        raise CrmError("A touchpoint needs at least one person or company.")
    occurred_at = data.get("occurred_at") or timezone.now()
    if timezone.is_naive(occurred_at):
        raise CrmError("occurred_at must include a UTC offset.")
    summary = (data.get("summary") or "").strip()
    if not summary:
        raise CrmError("A touchpoint needs a summary.")

    source = data.get("source") or TouchpointSource.MANUAL
    external_id = (data.get("external_id") or "").strip()
    fields = {
        "kind": data["kind"],
        "direction": data.get("direction") or "",
        "occurred_at": occurred_at,
        "summary": summary,
        "deal": deal,
    }

    touchpoint = None
    created = True
    if external_id:
        touchpoint = Touchpoint.objects.filter(
            source=source, external_id=external_id
        ).first()
    if touchpoint is not None:
        created = False
        for key, value in fields.items():
            if key == "deal" and value is None:
                continue
            setattr(touchpoint, key, value)
        touchpoint.save()
    else:
        try:
            with transaction.atomic():
                touchpoint = Touchpoint.objects.create(
                    source=source,
                    external_id=external_id,
                    created_by=user if getattr(user, "is_authenticated", False) else None,
                    **fields,
                )
        except IntegrityError:  # pragma: no cover - concurrent re-push
            touchpoint = Touchpoint.objects.get(source=source, external_id=external_id)
            created = False
    touchpoint.entities.add(*entities)

    task = None
    follow_up = data.get("follow_up")
    if follow_up and created:
        task = create_follow_up(
            entities[0],
            follow_up.get("title") or "",
            user=user,
            due=follow_up.get("due"),
            tz=data.get("tz"),
            deal=deal,
            assignee=follow_up.get("assignee"),
            source=data.get("transition_source") or TransitionSource.USER,
        )

    broadcast_crm_event(
        "touchpoint.created" if created else "touchpoint.updated",
        {"id": touchpoint.id, "entities": [e.id for e in entities]},
    )
    return touchpoint, created, task


TOUCHPOINT_FIELDS = ("kind", "direction", "occurred_at", "summary")

#: "Argument not passed" — distinct from ``None``, which means "clear it".
UNSET: Any = object()


@transaction.atomic
def update_touchpoint(
    touchpoint: Touchpoint,
    data: dict[str, Any],
    *,
    entities: list[Entity] | None = None,
    deal: Any = UNSET,
) -> Touchpoint:
    """Correct a logged touch or note. ``entities`` replaces who it was with;
    ``deal=None`` unlinks the deal, omitting it leaves the link alone."""
    for field in TOUCHPOINT_FIELDS:
        if field in data and data[field] is not None:
            setattr(touchpoint, field, data[field])
    if timezone.is_naive(touchpoint.occurred_at):
        raise CrmError("occurred_at must include a UTC offset.")
    if not (touchpoint.summary or "").strip():
        raise CrmError("A touchpoint needs a summary.")
    if deal is not UNSET:
        touchpoint.deal = deal
    touchpoint.save()
    before = set(touchpoint.entities.values_list("id", flat=True))
    if entities is not None:
        if not entities:
            raise CrmError("A touchpoint needs at least one person or company.")
        touchpoint.entities.set(entities)
    after = set(touchpoint.entities.values_list("id", flat=True))
    broadcast_crm_event(
        "touchpoint.updated", {"id": touchpoint.id, "entities": sorted(before | after)}
    )
    return touchpoint


def delete_touchpoint(touchpoint: Touchpoint) -> None:
    entity_ids = list(touchpoint.entities.values_list("id", flat=True))
    touchpoint.delete()
    broadcast_crm_event("touchpoint.deleted", {"entities": entity_ids})


# ---------------------------------------------------------------------------
# Deals
# ---------------------------------------------------------------------------


def _check_stage(pipeline: Pipeline, stage: Stage) -> None:
    if stage.pipeline_id != pipeline.pk:
        raise CrmError(f"Stage {stage.name!r} isn't in the {pipeline.name} pipeline.")


def _sync_closed(deal: Deal, previous_kind: str | None) -> None:
    now_closed = deal.stage.kind != StageKind.OPEN
    was_closed = previous_kind not in (None, StageKind.OPEN)
    if now_closed and not was_closed:
        deal.closed_at = timezone.now()
    elif not now_closed:
        deal.closed_at = None
        deal.lost_reason = ""


def _position_in(stage: Stage, index: int | None, *, exclude: int | None = None) -> float:
    """Midpoint position for slot ``index`` in ``stage`` (``None`` = bottom)."""
    siblings = list(
        Deal.objects.filter(stage=stage)
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
def create_deal(data: dict[str, Any], *, user) -> Deal:
    pipeline: Pipeline = data["pipeline"]
    stage: Stage | None = data.get("stage")
    if stage is None:
        stage = pipeline.stages.filter(kind=StageKind.OPEN).first()
        if stage is None:
            raise CrmError(f"{pipeline.name} has no open stage.")
    _check_stage(pipeline, stage)
    company = data.get("company")
    if company is not None and company.kind != EntityKind.COMPANY:
        raise CrmError(f"{company.name} is a person, not a company.")
    deal = Deal(
        title=data["title"],
        pipeline=pipeline,
        stage=stage,
        company=company,
        owner=data.get("owner"),
        value=data.get("value"),
        currency=data.get("currency") or "QAR",
        project=data.get("project"),
        expected_close=data.get("expected_close"),
        notes=data.get("notes") or "",
        position=_position_in(stage, None),
        created_by=user if getattr(user, "is_authenticated", False) else None,
    )
    _sync_closed(deal, None)
    deal.save()
    if data.get("contacts"):
        deal.contacts.set(data["contacts"])
    # A Mowafeq deal makes its company and people Mowafeq contacts.
    tag_projects([deal.company, *deal.contacts.all()], deal.project)
    broadcast_crm_event("deal.created", {"key": deal.key})
    return deal


DEAL_FIELDS = (
    "title",
    "company",
    "owner",
    "value",
    "currency",
    "project",
    "expected_close",
    "notes",
    "lost_reason",
)


@transaction.atomic
def update_deal(deal: Deal, data: dict[str, Any]) -> Deal:
    for field in DEAL_FIELDS:
        if field in data:
            setattr(deal, field, data[field])
    if deal.company is not None and deal.company.kind != EntityKind.COMPANY:
        raise CrmError(f"{deal.company.name} is a person, not a company.")
    if "pipeline" in data or "stage" in data:
        previous_kind = deal.stage.kind
        pipeline = data.get("pipeline") or deal.pipeline
        stage = data.get("stage")
        if stage is None and pipeline.pk == deal.pipeline_id:
            stage = deal.stage
        elif stage is None:
            # Switching pipelines without a stage lands in the first open one.
            stage = pipeline.stages.filter(kind=StageKind.OPEN).first()
            if stage is None:
                raise CrmError(f"{pipeline.name} has no open stage.")
        _check_stage(pipeline, stage)
        if stage.pk != deal.stage_id:
            deal.position = _position_in(stage, None, exclude=deal.pk)
        deal.pipeline, deal.stage = pipeline, stage
        _sync_closed(deal, previous_kind)
    deal.save()
    if data.get("contacts") is not None:
        deal.contacts.set(data["contacts"])
    tag_projects([deal.company, *deal.contacts.all()], deal.project)
    broadcast_crm_event("deal.updated", {"key": deal.key})
    return deal


@transaction.atomic
def move_deal(deal: Deal, stage: Stage, *, index: int | None = None) -> Deal:
    """Drag-and-drop: into ``stage`` (same pipeline) at slot ``index``."""
    _check_stage(deal.pipeline, stage)
    previous_kind = deal.stage.kind
    deal.position = _position_in(stage, index, exclude=deal.pk)
    deal.stage = stage
    _sync_closed(deal, previous_kind)
    deal.save()
    broadcast_crm_event("deal.moved", {"key": deal.key, "stage": stage.id})
    return deal


def delete_deal(deal: Deal) -> None:
    key = deal.key
    deal.delete()
    broadcast_crm_event("deal.deleted", {"key": key})


# ---------------------------------------------------------------------------
# Pipelines
# ---------------------------------------------------------------------------


@transaction.atomic
def create_pipeline(name: str, stages: list[dict[str, Any]] | None = None) -> Pipeline:
    from django.utils.text import slugify

    name = (name or "").strip()
    if not name:
        raise CrmError("A pipeline needs a name.")
    base = slugify(name) or "pipeline"
    slug, n = base, 2
    while Pipeline.objects.filter(slug=slug).exists():
        slug, n = f"{base}-{n}", n + 1
    position = (Pipeline.objects.aggregate(m=Max("position"))["m"] or 0) + 1
    pipeline = Pipeline.objects.create(name=name, slug=slug, position=position)
    set_stages(
        pipeline,
        stages
        or [
            {"name": "New", "kind": StageKind.OPEN},
            {"name": "Won", "kind": StageKind.WON},
            {"name": "Lost", "kind": StageKind.LOST},
        ],
        announce=False,
    )
    broadcast_crm_event("pipeline.updated", {"id": pipeline.id})
    return pipeline


@transaction.atomic
def set_stages(
    pipeline: Pipeline, stages: list[dict[str, Any]], *, announce: bool = True
) -> Pipeline:
    """Replace the pipeline's stages with this ordered list in one save — the
    TAS-069 column-editor contract. Entries with an ``id`` are renamed /
    re-kinded / reordered, new ones are created, missing ones deleted (refused
    while deals sit in them)."""
    if not stages:
        raise CrmError("A pipeline needs at least one stage.")
    if not any((s.get("kind") or StageKind.OPEN) == StageKind.OPEN for s in stages):
        raise CrmError("A pipeline needs at least one open stage.")
    existing = {s.pk: s for s in pipeline.stages.all()}
    keep: set[int] = set()
    for index, spec in enumerate(stages):
        name = (spec.get("name") or "").strip()
        if not name:
            raise CrmError("Every stage needs a name.")
        kind = spec.get("kind") or StageKind.OPEN
        if kind not in StageKind.values:
            raise CrmError(f"Unknown stage kind {kind!r}.")
        stage_id = spec.get("id")
        if stage_id:
            stage = existing.get(int(stage_id))
            if stage is None:
                raise CrmError(f"Stage {stage_id} isn't in {pipeline.name}.")
            stage.name, stage.kind, stage.position = name, kind, float(index)
            stage.save()
            keep.add(stage.pk)
        else:
            stage = Stage.objects.create(
                pipeline=pipeline, name=name, kind=kind, position=float(index)
            )
            keep.add(stage.pk)
    for stage_id, stage in existing.items():
        if stage_id in keep:
            continue
        if stage.deals.exists():
            raise CrmError(
                f"Stage {stage.name!r} still has deals — move them before removing it."
            )
        stage.delete()
    if announce:
        broadcast_crm_event("pipeline.updated", {"id": pipeline.id})
    return pipeline


@transaction.atomic
def rename_pipeline(pipeline: Pipeline, name: str) -> Pipeline:
    name = (name or "").strip()
    if not name:
        raise CrmError("A pipeline needs a name.")
    pipeline.name = name
    pipeline.save(update_fields=["name", "updated_at"])
    broadcast_crm_event("pipeline.updated", {"id": pipeline.id})
    return pipeline


def delete_pipeline(pipeline: Pipeline) -> None:
    if pipeline.deals.exists():
        raise CrmError(f"{pipeline.name} still has deals.")
    pipeline_id = pipeline.id
    pipeline.delete()
    broadcast_crm_event("pipeline.updated", {"id": pipeline_id})
