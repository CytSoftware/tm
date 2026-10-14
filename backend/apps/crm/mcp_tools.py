"""Sync implementations behind the CRM MCP tools.

Same rule as :mod:`apps.meetings.mcp_tools`: **no logic of its own**. Reads go
through ``query.py``, writes through ``services.py``. What lives here is the
translation from an agent-friendly flat argument list — people by name, id or
email; leads by key; users by username — into those modules.
"""

from __future__ import annotations

import json
from datetime import datetime, time
from typing import Any

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from apps.meetings.mcp_tools import _get_entity
from apps.meetings.models import Entity, EntityEmail, EntityKind, Meeting
from apps.tasks.models import Task, TransitionSource

from . import services
from .models import Lead, LeadStage, Update, UpdateKind
from .query import (
    base_contact_queryset,
    filter_contacts,
    filter_leads,
    filter_updates,
    lead_people,
    open_steps,
)
from .serializers import ContactSerializer, LeadSerializer, step_dict, update_dict

MAX_LIST_LIMIT = 200


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _json(data: Any) -> Any:
    """Serializer output / datetimes / Decimals → plain JSON values."""
    return json.loads(json.dumps(data, cls=DjangoJSONEncoder))


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except services.CrmError as exc:
        raise ValueError(str(exc))


def _entity(ref: str | int, kind: str | None = None) -> Entity:
    """An id, a name / slug / alias, or an email address we know."""
    text = str(ref).strip()
    if "@" in text:
        row = EntityEmail.objects.filter(email=text.lower()).select_related("entity").first()
        if row is None:
            raise ValueError(f"No contact has the address {text!r}.")
        return row.entity
    return _get_entity(text, kind)


def _person(ref: str | int) -> Entity:
    return _entity(ref, None if "@" in str(ref) else EntityKind.PERSON)


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


def _lead(ref: str) -> Lead:
    lead = Lead.objects.filter(key__iexact=str(ref).strip()).first()
    if lead is None:
        raise ValueError(f"Lead {ref!r} not found (pass a key like LEAD-003).")
    return lead


def _meeting(ref: str) -> Meeting:
    meeting = Meeting.objects.filter(key__iexact=str(ref).strip()).first()
    if meeting is None:
        raise ValueError(f"Meeting {ref!r} not found (pass a key like MTG-064).")
    return meeting


def _scope(ref: str | int | None) -> int | None:
    """A project filter for the read tools — unknown names raise, so an agent
    learns about a typo instead of getting an empty list."""
    if ref in (None, ""):
        return None
    return _guard(services.resolve_project, ref).pk


def _stage(value: str) -> str:
    stage = str(value).strip().lower()
    if stage not in LeadStage.values:
        raise ValueError(f"stage must be one of {', '.join(LeadStage.values)}.")
    return stage


def _kind(value: str | None) -> str | None:
    if value is None:
        return None
    if value not in UpdateKind.values:
        raise ValueError(f"kind must be one of {', '.join(UpdateKind.values)}.")
    return value


def _aware(value: str | None):
    if not value:
        return None
    if len(value) == 10:
        # A bare date (a remembered call) → midday, local.
        day = parse_date(value)
        if day is None:
            raise ValueError(f"Can't read {value!r} as a date.")
        return datetime.combine(day, time(12, 0), tzinfo=services.resolve_tz(None))
    parsed = parse_datetime(value)
    if parsed is None:
        raise ValueError(f"Can't read {value!r} as a timestamp.")
    if timezone.is_naive(parsed):
        raise ValueError("occurred_at must include a UTC offset, e.g. 2026-10-05T14:00:00+03:00.")
    return parsed


def _lead_summary(lead: Lead) -> dict:
    data = dict(LeadSerializer(lead).data)
    data.pop("position", None)
    data["url"] = f"{settings.FRONTEND_URL}/crm?l={lead.key}"
    return _json(data)


def _step(task: Task) -> dict:
    return _json({**step_dict(task), "assignees": [u.username for u in task.assignees.all()]})


def _update(u: Update) -> dict:
    data = update_dict(u)
    if u.task_id:
        data["task"] = _step(u.task)
    data["users"] = [x["username"] for x in data["users"]]
    data["created_by"] = data["created_by"]["username"] if data["created_by"] else None
    data["people"] = [p["name"] for p in data["people"]]
    return _json(data)


def _contact(entity: Entity, *, detail: bool = False, limit: int = 30) -> dict:
    fresh = base_contact_queryset().get(pk=entity.pk)
    data = dict(ContactSerializer(fresh).data)
    data.pop("slug", None)
    tab = "companies" if fresh.kind == EntityKind.COMPANY else "people"
    data["url"] = f"{settings.FRONTEND_URL}/crm?tab={tab}&c={fresh.id}"
    if detail:
        if fresh.kind == EntityKind.COMPANY:
            data["people"] = [
                {"id": p.id, "name": p.name, "position": p.position} for p in fresh.people.all()
            ]
        data["leads"] = [_lead_summary(lead) for lead in filter_leads({"entity": fresh.pk})]
        data["updates"] = [_update(u) for u in filter_updates({"entity": fresh.pk})[:limit]]
    return _json(data)


# ---------------------------------------------------------------------------
# People & companies
# ---------------------------------------------------------------------------


def search_contacts(
    query: str | None = None,
    kind: str | None = None,
    company: str | int | None = None,
    project: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {"search": query, "kind": kind, "project": _scope(project)}
    if company not in (None, ""):
        filters["company"] = _entity(company, EntityKind.COMPANY).pk
    rows = filter_contacts(filters)[: max(1, min(limit, MAX_LIST_LIMIT))]
    return [_contact(e) for e in rows]


def get_contact(contact: str | int, kind: str | None = None, limit: int = 30) -> dict:
    return _contact(_entity(contact, kind), detail=True, limit=limit)


def upsert_contact(
    name: str,
    kind: str = "person",
    company: str | int | None = None,
    position: str | None = None,
    emails: list[str] | None = None,
    phone: str | None = None,
    linkedin_url: str | None = None,
    website: str | None = None,
    wiki_slug: str | None = None,
    rename_to: str | None = None,
) -> dict[str, Any]:
    if kind not in EntityKind.values:
        raise ValueError("kind must be 'person' or 'company'.")
    data: dict[str, Any] = {
        "position": position,
        "phone": phone,
        "linkedin_url": linkedin_url,
        "website": website,
        "wiki_slug": wiki_slug,
    }
    data = {k: v for k, v in data.items() if v is not None}
    if company is not None:
        data["company"] = company
    if emails is not None:
        # Additive: an agent rarely knows every address a person has.
        data["add_emails"] = emails

    text = str(name).strip()
    if text.isdigit() or "@" in text:
        # An id or address names one entity already; ``kind`` only
        # disambiguates names, so a company id works under the default.
        entity, created = _entity(text), False
        _guard(services.update_contact, entity, data)
    else:
        entity, created = _guard(services.create_contact, {"name": text, "kind": kind, **data})
    # Rename after resolving: passing the new name to create_contact would
    # look *it* up and create a second entity.
    if rename_to:
        _guard(services.update_contact, entity, {"name": rename_to})
    return {"created": created, **_contact(entity)}


# ---------------------------------------------------------------------------
# Leads
# ---------------------------------------------------------------------------


def search_leads(
    query: str | None = None,
    stage: str | None = None,
    status: str | None = None,
    contact: str | int | None = None,
    project: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {
        "search": query,
        "stage": _stage(stage) if stage else None,
        "status": status,
        "project": _scope(project),
    }
    if contact not in (None, ""):
        filters["entity"] = _entity(contact).pk
    rows = filter_leads(filters)[: max(1, min(limit, MAX_LIST_LIMIT))]
    return [_lead_summary(lead) for lead in rows]


def get_lead(lead: str, limit: int = 50) -> dict[str, Any]:
    target = filter_leads().get(pk=_lead(lead).pk)
    data = _lead_summary(target)
    data["people"] = [
        {"id": p.id, "name": p.name, "position": p.position} for p in lead_people(target)
    ]
    steps = open_steps().filter(crm_update__lead=target).select_related("column")
    data["open_steps"] = [_step(t) for t in steps.prefetch_related("assignees")]
    data["updates"] = [_update(u) for u in filter_updates({"lead": target.key})[:limit]]
    return data


def upsert_lead(
    title: str | None = None,
    lead: str | None = None,
    stage: str | None = None,
    company: str | int | None = None,
    project: str | None = None,
    notes: str | None = None,
    lost_reason: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    data: dict[str, Any] = {}
    if title is not None:
        data["title"] = title
    if stage is not None:
        data["stage"] = _stage(stage)
    if company is not None:
        data["company"] = (
            _guard(services._resolve_company, company) if company != "" else None
        )
    if project is not None:
        data["project"] = _guard(services.resolve_project, project) if project != "" else None
    if notes is not None:
        data["notes"] = notes
    if lost_reason is not None:
        data["lost_reason"] = lost_reason
    if lead:
        target = _lead(lead)
        _guard(services.update_lead, target, data)
    else:
        if not title:
            raise ValueError("A new lead needs a title (or pass `lead` to edit one).")
        target = _guard(services.create_lead, data, user=_reporter(mcp_user))
    return _lead_summary(filter_leads().get(pk=target.pk))


def delete_lead(lead: str) -> dict[str, Any]:
    target = _lead(lead)
    key = target.key
    services.delete_lead(target)
    return {"ok": True, "key": key}


# ---------------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------------


def post_update(
    body: str,
    lead: str | None = None,
    kind: str | None = None,
    people: list[str | int] | None = None,
    users: list[str] | None = None,
    meeting: str | None = None,
    occurred_at: str | None = None,
    next_step: str | None = None,
    next_due: str | None = None,
    next_assignee: str | None = None,
    tz: str | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    reporter = _reporter(mcp_user)
    data: dict[str, Any] = {
        "body": body,
        "kind": _kind(kind),
        "occurred_at": _aware(occurred_at),
        "next_step": next_step,
        "next_due": next_due,
        "next_assignee": _user(next_assignee),
        "tz": tz,
        "transition_source": TransitionSource.MCP,
    }
    team = [_user(u) for u in users] if users is not None else (
        [reporter] if getattr(reporter, "is_authenticated", False) else []
    )
    update = _guard(
        services.post_update,
        data,
        user=reporter,
        lead=_lead(lead) if lead else None,
        people=[_person(p) for p in people or []],
        users=team,
        meeting=_meeting(meeting) if meeting else None,
    )
    return _update(filter_updates().get(pk=update.pk))


def _update_row(update_id: int) -> Update:
    found = Update.objects.filter(pk=update_id).first()
    if found is None:
        raise ValueError(f"No update {update_id} (ids are in get_lead / get_contact).")
    return found


def edit_update(
    update_id: int,
    body: str | None = None,
    kind: str | None = None,
    occurred_at: str | None = None,
    lead: str | None = None,
    people: list[str | int] | None = None,
    users: list[str] | None = None,
    meeting: str | None = None,
) -> dict[str, Any]:
    target = _update_row(update_id)
    data = {"body": body, "kind": _kind(kind), "occurred_at": _aware(occurred_at)}
    kwargs: dict[str, Any] = {}
    if lead is not None:
        kwargs["lead"] = _lead(lead) if lead else None
    if meeting is not None:
        kwargs["meeting"] = _meeting(meeting) if meeting else None
    if people is not None:
        kwargs["people"] = [_person(p) for p in people]
    if users is not None:
        kwargs["users"] = [_user(u) for u in users]
    _guard(services.edit_update, target, data, **kwargs)
    return _update(filter_updates().get(pk=target.pk))


def complete_next_step(task: str, done: bool = True, mcp_user=None) -> dict[str, Any]:
    target = (
        Task.objects.select_related("column", "project")
        .filter(key__iexact=task.strip(), crm_update__isnull=False)
        .first()
    )
    if target is None:
        raise ValueError(f"{task!r} is not a CRM next step.")
    _guard(
        services.set_step_done, target, done, user=_reporter(mcp_user), source=TransitionSource.MCP
    )
    target.refresh_from_db()
    return _step(target)


def delete_update(update_id: int) -> dict[str, Any]:
    services.delete_update(_update_row(update_id))
    return {"ok": True, "id": update_id}


def list_crm_activity(
    days: int = 14, limit: int = 100, project: str | None = None
) -> list[dict[str, Any]]:
    rows = filter_updates({"days": max(1, days), "project": _scope(project)})
    return [_update(u) for u in rows[: max(1, min(limit, MAX_LIST_LIMIT))]]
