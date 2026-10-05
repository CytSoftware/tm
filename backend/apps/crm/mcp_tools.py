"""Sync implementations behind the CRM MCP tools.

Same rule as :mod:`apps.meetings.mcp_tools`: **no logic of its own**. Reads go
through ``query.py`` / ``timeline.py``, writes through ``services.py``. What
lives here is the translation from an agent-friendly flat argument list —
people by name, id or email; stages by name; users by username — into those
modules.
"""

from __future__ import annotations

import json
from datetime import datetime, time
from decimal import Decimal, InvalidOperation
from typing import Any

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.utils.dateparse import parse_date, parse_datetime
from django.utils import timezone

from apps.meetings.models import Entity, EntityEmail, EntityKind
from apps.meetings.mcp_tools import _get_entity
from apps.tasks.models import Project, TransitionSource

from . import services
from .models import Deal, FollowUp, Pipeline, Stage, TouchpointKind, TouchpointSource
from .query import (
    base_contact_queryset,
    bucket_follow_ups,
    filter_contacts,
    filter_deals,
    open_follow_ups,
    without_listed_companies_people,
)
from .serializers import ContactSerializer, DealSerializer, PipelineSerializer, follow_up_dict
from .timeline import entity_timeline

MAX_LIST_LIMIT = 200


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _json(data: Any) -> Any:
    """Serializer output / datetimes / Decimals → plain JSON values."""
    return json.loads(json.dumps(data, cls=DjangoJSONEncoder))


def contact_url(entity: Entity) -> str:
    return f"{settings.FRONTEND_URL}/crm?tab=contacts&c={entity.id}"


def _entity(ref: str | int, kind: str | None = None) -> Entity:
    """An id, a name / slug / alias, or an email address we know."""
    text = str(ref).strip()
    if "@" in text:
        row = EntityEmail.objects.filter(email=text.lower()).select_related("entity").first()
        if row is None:
            raise ValueError(f"No contact has the address {text!r}.")
        return row.entity
    return _get_entity(text, kind)


def _user(ref: str | int | None):
    if ref in (None, ""):
        return None
    from apps.mcp_server.tools import _resolve_user

    try:
        return _resolve_user(ref)
    except Exception:
        raise ValueError(f"No user {ref!r} (pass a username or id).")


def _reporter(mcp_user):
    from apps.mcp_server.tools import _resolve_reporter_for_mcp

    return _resolve_reporter_for_mcp(mcp_user)


def _pipeline(ref: str | int) -> Pipeline:
    text = str(ref).strip()
    qs = Pipeline.objects.all()
    found = (
        qs.filter(pk=int(text)).first()
        if text.isdigit()
        else (qs.filter(slug__iexact=text).first() or qs.filter(name__iexact=text).first())
    )
    if found is None:
        names = ", ".join(qs.values_list("name", flat=True))
        raise ValueError(f"No pipeline {ref!r}. Pipelines: {names}.")
    return found


def _stage(pipeline: Pipeline, ref: str | int) -> Stage:
    text = str(ref).strip()
    qs = pipeline.stages.all()
    found = (
        qs.filter(pk=int(text)).first()
        if text.isdigit()
        else qs.filter(name__iexact=text).first()
    )
    if found is None:
        names = ", ".join(qs.values_list("name", flat=True))
        raise ValueError(f"{pipeline.name} has no stage {ref!r}. Stages: {names}.")
    return found


def _deal(ref: str) -> Deal:
    deal = Deal.objects.filter(key__iexact=str(ref).strip()).first()
    if deal is None:
        raise ValueError(f"Deal {ref!r} not found (pass a key like DEAL-003).")
    return deal


def _project(ref: str | int | None) -> Project | None:
    if ref in (None, ""):
        return None
    text = str(ref)
    project = (
        Project.objects.filter(pk=int(text)).first()
        if text.isdigit()
        else Project.objects.filter(prefix__iexact=text).first()
        or Project.objects.filter(name__iexact=text).first()
    )
    if project is None:
        raise ValueError(f"No project {ref!r}.")
    return project


def _money(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        raise ValueError(f"value must be a number, got {value!r}.")


def _date(value: Any):
    if value in (None, ""):
        return None
    parsed = parse_date(str(value))
    if parsed is None:
        raise ValueError(f"Expected a date like 2026-11-30, got {value!r}.")
    return parsed


def _aware(value: str | None):
    if not value:
        return None
    if len(value) == 10:
        # A bare date (an old reminder, a remembered call) → midday, local.
        day = parse_date(value)
        if day is None:
            raise ValueError(f"Can't read {value!r} as a date.")
        return datetime.combine(day, time(12, 0), tzinfo=services.resolve_tz(None))
    parsed = parse_datetime(value)
    if parsed is None:
        raise ValueError(f"Can't read {value!r} as a timestamp.")
    if timezone.is_naive(parsed):
        raise ValueError(
            "occurred_at must include a UTC offset, e.g. 2026-10-05T14:00:00+03:00."
        )
    return parsed


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except services.CrmError as exc:
        raise ValueError(str(exc))


def _contact(entity: Entity, *, detail: bool = False, timeline_limit: int = 30) -> dict:
    fresh = base_contact_queryset().get(pk=entity.pk)
    data = dict(ContactSerializer(fresh).data)
    data.pop("slug", None)
    data["owner"] = fresh.owner.username if fresh.owner_id else None
    data["url"] = contact_url(fresh)
    if detail:
        if fresh.kind == EntityKind.COMPANY:
            data["people"] = [
                {"id": p.id, "name": p.name, "headline": p.headline, "relationship": p.relationship}
                for p in fresh.people.all()
            ]
        data["deals"] = [_deal_summary(d) for d in filter_deals({"entity": fresh.pk})]
        data["open_follow_ups"] = [
            _follow_up(f) for f in open_follow_ups({"entity": fresh.pk})
        ]
        data["timeline"] = entity_timeline(fresh, limit=timeline_limit)
    return _json(data)


def _deal_summary(deal: Deal) -> dict:
    data = dict(DealSerializer(deal).data)
    data["owner"] = deal.owner.username if deal.owner_id else None
    data["stage"] = deal.stage.name
    data["stage_kind"] = deal.stage.kind
    data["pipeline"] = deal.pipeline.name
    data.pop("position", None)
    return _json(data)


def _follow_up(f: FollowUp) -> dict:
    data = follow_up_dict(f)
    data["assignees"] = [u["username"] for u in data["assignees"]]
    return _json(data)


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------


def search_contacts(
    query: str | None = None,
    relationship: str | None = None,
    kind: str | None = None,
    owner: str | None = None,
    company: str | int | None = None,
    no_next_step: bool = False,
    overdue: bool = False,
    sort: str = "last_contact",
    limit: int = 50,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {
        "search": query,
        "relationship": relationship,
        "kind": kind,
        "owner": owner,
        "no_next_step": no_next_step,
        "overdue": overdue,
    }
    if company not in (None, ""):
        filters["company"] = _entity(company, EntityKind.COMPANY).pk
    limit = max(1, min(limit, MAX_LIST_LIMIT))
    rows = filter_contacts(filters, sort=sort)[:limit]
    return [_contact(e) for e in rows]


def get_contact(contact: str | int, kind: str | None = None, timeline_limit: int = 30) -> dict:
    return _contact(_entity(contact, kind), detail=True, timeline_limit=timeline_limit)


def find_contacts_by_email(emails: list[str]) -> dict[str, Any]:
    found = services.find_by_emails(emails)
    return {
        "matches": {
            email: {
                "id": e.id,
                "name": e.name,
                "kind": e.kind,
                "relationship": e.relationship,
                "company": e.company.name if e.company_id else None,
            }
            for email, e in found.items()
        },
        "unknown": [e for e in emails if e.strip().lower() not in found],
    }


def upsert_contact(
    name: str,
    kind: str = "person",
    relationship: str | None = None,
    owner: str | None = None,
    headline: str | None = None,
    company: str | int | None = None,
    emails: list[str] | None = None,
    phone: str | None = None,
    whatsapp: str | None = None,
    linkedin_url: str | None = None,
    website: str | None = None,
    wiki_slug: str | None = None,
    rename_to: str | None = None,
) -> dict[str, Any]:
    if kind not in EntityKind.values:
        raise ValueError("kind must be 'person' or 'company'.")
    data: dict[str, Any] = {
        "kind": kind,
        "relationship": relationship,
        "headline": headline,
        "phone": phone,
        "whatsapp": whatsapp,
        "linkedin_url": linkedin_url,
        "website": website,
        "wiki_slug": wiki_slug,
    }
    data = {k: v for k, v in data.items() if v is not None}
    if owner is not None:
        data["owner"] = _user(owner)
    if company is not None:
        data["company"] = company
    if emails is not None:
        # Additive: an agent rarely knows every address a person has.
        data["add_emails"] = emails
    if rename_to:
        data["name"] = rename_to

    text = str(name).strip()
    if text.isdigit() or "@" in text:
        entity = _entity(text, kind)
        _guard(services.update_contact, entity, data)
        created = False
    else:
        entity, created = _guard(services.create_contact, {"name": text, **data})
    return {"created": created, **_contact(entity)}


# ---------------------------------------------------------------------------
# Touchpoints & follow-ups
# ---------------------------------------------------------------------------


def log_touchpoint(
    kind: str,
    summary: str,
    people: list[str | int] | None = None,
    companies: list[str | int] | None = None,
    occurred_at: str | None = None,
    direction: str | None = None,
    deal: str | None = None,
    source: str = "agent",
    external_id: str | None = None,
    follow_up_title: str | None = None,
    follow_up_due: str | None = None,
    follow_up_assignee: str | None = None,
    tz: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    if kind not in TouchpointKind.values:
        raise ValueError(f"kind must be one of {', '.join(TouchpointKind.values)}.")
    if source not in TouchpointSource.values:
        raise ValueError(f"source must be one of {', '.join(TouchpointSource.values)}.")
    entities = [_entity(p, EntityKind.PERSON if "@" not in str(p) else None) for p in people or []]
    entities += [_entity(c, EntityKind.COMPANY) for c in companies or []]
    data: dict[str, Any] = {
        "kind": kind,
        "summary": summary,
        "occurred_at": _aware(occurred_at),
        "direction": direction or "",
        "source": source,
        "external_id": external_id or "",
        "tz": tz,
        "transition_source": TransitionSource.MCP,
    }
    if follow_up_title:
        data["follow_up"] = {
            "title": follow_up_title,
            "due": follow_up_due,
            "assignee": _user(follow_up_assignee),
        }
    touchpoint, created, task = _guard(
        services.log_touchpoint,
        data,
        entities,
        user=_reporter(mcp_user),
        deal=_deal(deal) if deal else None,
    )
    return _json(
        {
            "id": touchpoint.id,
            "created": created,
            "people": [e.name for e in touchpoint.entities.all()],
            "follow_up": task.key if task else None,
        }
    )


def create_follow_up(
    contact: str | int,
    title: str,
    due: str | None = None,
    deal: str | None = None,
    assignee: str | None = None,
    description: str = "",
    kind: str | None = None,
    tz: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    task = _guard(
        services.create_follow_up,
        _entity(contact, kind),
        title,
        user=_reporter(mcp_user),
        due=due,
        tz=tz,
        deal=_deal(deal) if deal else None,
        assignee=_user(assignee),
        description=description,
        source=TransitionSource.MCP,
    )
    return _follow_up(task.crm_follow_up)


def update_follow_up(
    task: str,
    done: bool | None = None,
    due: str | None = None,
    tz: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    follow_up = (
        FollowUp.objects.select_related("task__column", "task__project", "entity")
        .filter(task__key__iexact=task.strip())
        .first()
    )
    if follow_up is None:
        raise ValueError(f"{task!r} is not a CRM follow-up.")
    user = _reporter(mcp_user)
    if due is not None:
        _guard(services.reschedule_follow_up, follow_up, due, user=user, tz=tz)
    if done is True:
        _guard(services.complete_follow_up, follow_up, user=user, source=TransitionSource.MCP)
    elif done is False:
        _guard(services.reopen_follow_up, follow_up, user=user, source=TransitionSource.MCP)
    follow_up.refresh_from_db()
    follow_up.task.refresh_from_db()
    return _follow_up(follow_up)


def list_follow_ups(owner: str | None = None, tz: str | None = None) -> dict[str, Any]:
    today, grouped = bucket_follow_ups(
        open_follow_ups({"owner": owner} if owner else None), services.resolve_tz(tz)
    )
    buckets = {name: [_follow_up(f) for f in rows] for name, rows in grouped.items()}
    no_next = without_listed_companies_people(
        filter_contacts({"no_next_step": True, "owner": owner})
    )
    return {
        "today": today.isoformat(),
        **buckets,
        "no_next_step": [{"id": e.id, "name": e.name, "relationship": e.relationship} for e in no_next],
    }


# ---------------------------------------------------------------------------
# Deals & pipelines
# ---------------------------------------------------------------------------


def list_pipelines() -> list[dict[str, Any]]:
    return _json(
        [PipelineSerializer(p).data for p in Pipeline.objects.prefetch_related("stages")]
    )


def search_deals(
    query: str | None = None,
    pipeline: str | None = None,
    status: str | None = None,
    contact: str | int | None = None,
    owner: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {"search": query, "status": status, "owner": owner}
    if pipeline:
        filters["pipeline"] = _pipeline(pipeline).pk
    if contact not in (None, ""):
        filters["entity"] = _entity(contact).pk
    limit = max(1, min(limit, MAX_LIST_LIMIT))
    return [_deal_summary(d) for d in filter_deals(filters)[:limit]]


def get_deal(deal: str) -> dict[str, Any]:
    target = _deal(deal)
    data = _deal_summary(target)
    data["follow_ups"] = [_follow_up(f) for f in target.follow_ups.select_related("task__column", "entity__company", "deal")]
    data["touchpoints"] = _json(
        [
            {"at": t.occurred_at, "kind": t.kind, "summary": t.summary}
            for t in target.touchpoints.all()
        ]
    )
    return data


def _deal_data(
    *,
    title=None,
    company=None,
    contacts=None,
    owner=None,
    value=None,
    currency=None,
    product=None,
    expected_close=None,
    notes=None,
    lost_reason=None,
) -> dict[str, Any]:
    data: dict[str, Any] = {}
    if title is not None:
        data["title"] = title
    if company is not None:
        data["company"] = _entity(company, EntityKind.COMPANY) if company != "" else None
    if contacts is not None:
        data["contacts"] = [_entity(c, EntityKind.PERSON) for c in contacts]
    if owner is not None:
        data["owner"] = _user(owner)
    if value is not None:
        data["value"] = _money(value)
    if currency is not None:
        data["currency"] = currency.upper()[:3]
    if product is not None:
        data["product_project"] = _project(product)
    if expected_close is not None:
        data["expected_close"] = _date(expected_close)
    if notes is not None:
        data["notes"] = notes
    if lost_reason is not None:
        data["lost_reason"] = lost_reason
    return data


def create_deal(
    title: str,
    pipeline: str = "sales",
    stage: str | None = None,
    company: str | int | None = None,
    contacts: list[str | int] | None = None,
    owner: str | None = None,
    value: float | str | None = None,
    currency: str | None = None,
    product: str | None = None,
    expected_close: str | None = None,
    notes: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    pipe = _pipeline(pipeline)
    data = _deal_data(
        title=title,
        company=company,
        contacts=contacts,
        owner=owner,
        value=value,
        currency=currency,
        product=product,
        expected_close=expected_close,
        notes=notes,
    )
    data["pipeline"] = pipe
    if stage:
        data["stage"] = _stage(pipe, stage)
    deal = _guard(services.create_deal, data, user=_reporter(mcp_user))
    return _deal_summary(deal)


def update_deal(
    deal: str,
    title: str | None = None,
    stage: str | None = None,
    pipeline: str | None = None,
    company: str | int | None = None,
    contacts: list[str | int] | None = None,
    owner: str | None = None,
    value: float | str | None = None,
    currency: str | None = None,
    product: str | None = None,
    expected_close: str | None = None,
    notes: str | None = None,
    lost_reason: str | None = None,
) -> dict[str, Any]:
    target = _deal(deal)
    data = _deal_data(
        title=title,
        company=company,
        contacts=contacts,
        owner=owner,
        value=value,
        currency=currency,
        product=product,
        expected_close=expected_close,
        notes=notes,
        lost_reason=lost_reason,
    )
    pipe = _pipeline(pipeline) if pipeline else target.pipeline
    if pipeline:
        data["pipeline"] = pipe
    if stage:
        data["stage"] = _stage(pipe, stage)
    _guard(services.update_deal, target, data)
    return _deal_summary(Deal.objects.get(pk=target.pk))


def delete_deal(deal: str) -> dict[str, Any]:
    target = _deal(deal)
    key = target.key
    services.delete_deal(target)
    return {"ok": True, "key": key}


# ---------------------------------------------------------------------------
# Notes, history & corrections
# ---------------------------------------------------------------------------


def add_contact_note(
    contact: str | int,
    note: str,
    kind: str | None = None,
    occurred_at: str | None = None,
    deal: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    entity = _entity(contact, kind)
    return log_touchpoint(
        "note",
        note,
        people=[entity.pk] if entity.kind == EntityKind.PERSON else None,
        companies=[entity.pk] if entity.kind == EntityKind.COMPANY else None,
        occurred_at=occurred_at,
        deal=deal,
        source="agent",
        mcp_user=mcp_user,
    )


def _touchpoint(touchpoint_id: int):
    from .models import Touchpoint

    found = Touchpoint.objects.filter(pk=touchpoint_id).first()
    if found is None:
        raise ValueError(f"No touchpoint {touchpoint_id} (ids are in get_contact's timeline).")
    return found


def update_touchpoint(
    touchpoint_id: int,
    summary: str | None = None,
    kind: str | None = None,
    occurred_at: str | None = None,
    direction: str | None = None,
    people: list[str | int] | None = None,
    companies: list[str | int] | None = None,
    deal: str | None = None,
) -> dict[str, Any]:
    target = _touchpoint(touchpoint_id)
    if kind is not None and kind not in TouchpointKind.values:
        raise ValueError(f"kind must be one of {', '.join(TouchpointKind.values)}.")
    data = {
        "summary": summary,
        "kind": kind,
        "occurred_at": _aware(occurred_at) if occurred_at else None,
        "direction": direction,
    }
    kwargs: dict[str, Any] = {}
    if people is not None or companies is not None:
        kwargs["entities"] = [
            _entity(p, EntityKind.PERSON if "@" not in str(p) else None) for p in people or []
        ] + [_entity(c, EntityKind.COMPANY) for c in companies or []]
    if deal is not None:
        kwargs["deal"] = _deal(deal) if deal else None
    _guard(services.update_touchpoint, target, data, **kwargs)
    target.refresh_from_db()
    return _json(
        {
            "id": target.id,
            "kind": target.kind,
            "occurred_at": target.occurred_at,
            "summary": target.summary,
            "people": [e.name for e in target.entities.all()],
            "deal": target.deal.key if target.deal_id else None,
        }
    )


def delete_touchpoint(touchpoint_id: int) -> dict[str, Any]:
    services.delete_touchpoint(_touchpoint(touchpoint_id))
    return {"ok": True, "id": touchpoint_id}


def list_crm_activity(days: int = 14, limit: int = 100) -> list[dict[str, Any]]:
    from .timeline import crm_activity

    return _json(crm_activity(days=days, limit=max(1, min(limit, MAX_LIST_LIMIT))))


# ---------------------------------------------------------------------------
# Pipelines
# ---------------------------------------------------------------------------


def _stage_specs(stages: list[Any], pipeline: Pipeline | None = None) -> list[dict[str, Any]]:
    """Accept names (``"Demo"``) or ``{name, kind, id?}``. A bare name that
    matches an existing stage keeps its id (and its deals)."""
    existing = {s.name.lower(): s for s in pipeline.stages.all()} if pipeline else {}
    specs = []
    for entry in stages:
        spec = {"name": entry} if isinstance(entry, str) else dict(entry)
        name = (spec.get("name") or "").strip()
        match = existing.get(name.lower())
        if "id" not in spec and match is not None:
            spec["id"] = match.pk
            spec.setdefault("kind", match.kind)
        spec.setdefault("kind", "open")
        specs.append(spec)
    return specs


def create_pipeline(name: str, stages: list[Any] | None = None) -> dict[str, Any]:
    pipeline = _guard(services.create_pipeline, name, _stage_specs(stages) if stages else None)
    return _json(PipelineSerializer(pipeline).data)


def update_pipeline(
    pipeline: str | int, name: str | None = None, stages: list[Any] | None = None
) -> dict[str, Any]:
    target = _pipeline(pipeline)
    if name:
        _guard(services.rename_pipeline, target, name)
    if stages is not None:
        _guard(services.set_stages, target, _stage_specs(stages, target))
    return _json(PipelineSerializer(Pipeline.objects.get(pk=target.pk)).data)


def delete_pipeline(pipeline: str | int) -> dict[str, Any]:
    target = _pipeline(pipeline)
    name = target.name
    _guard(services.delete_pipeline, target)
    return {"ok": True, "pipeline": name}
