"""Sync implementations behind the CRM MCP tools.

Same rule as :mod:`apps.meetings.mcp_tools`: **no logic of its own**. Reads go
through ``query.py``, writes through ``services.py``. What lives here is the
translation from an agent-friendly flat argument list — people by name, id or
email; leads by key; users by username — into those modules.

Every tool takes ``mcp_user`` and scopes through the same ``user`` argument as
REST; a lead, meeting or contact the caller can't see reads as "not found".
``mcp_user=None`` is a user-less operator credential and sees everything.
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
from apps.tasks.access import can_see_project, scope_for_caller
from apps.tasks.models import Task, TransitionSource

from . import services
from .models import Lead, LeadStage, Update, UpdateKind
from .query import (
    base_contact_queryset,
    base_update_queryset,
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


def _lead(ref: str, mcp_user, module: str = "crm") -> Lead:
    lead = (
        scope_for_caller(Lead.objects.all(), mcp_user, module)
        .filter(key__iexact=str(ref).strip())
        .first()
    )
    if lead is None:
        raise ValueError(f"Lead {ref!r} not found (pass a key like LEAD-003).")
    return lead


def _meeting(ref: str, mcp_user) -> Meeting:
    meeting = (
        scope_for_caller(Meeting.objects.all(), mcp_user, "meetings")
        .filter(key__iexact=str(ref).strip())
        .first()
    )
    if meeting is None:
        raise ValueError(f"Meeting {ref!r} not found (pass a key like MTG-064).")
    return meeting


def _scope(ref: str | int | None, mcp_user, module: str = "crm") -> int | None:
    """A project filter for the read tools — unknown names raise, so an agent
    learns about a typo instead of getting an empty list. A project the
    caller can't see in ``module`` is unknown too."""
    if ref in (None, ""):
        return None
    project = _guard(services.resolve_project, ref)
    if mcp_user is not None and not can_see_project(mcp_user, project.pk, module):
        raise ValueError(f"No project {ref!r}.")
    return project.pk


def _project(ref: str, mcp_user, module: str):
    """A project to file under, by the same rule as ``_scope``."""
    return services.Project.objects.get(pk=_scope(ref, mcp_user, module))


def _stage(value: str) -> str:
    stage = str(value).strip().lower().replace(" ", "_")
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


def _update(u: Update, mcp_user) -> dict:
    data = update_dict(u, context={"user": mcp_user})
    if u.task_id:
        data["task"] = _step(u.task)
    data["users"] = [x["username"] for x in data["users"]]
    data["created_by"] = data["created_by"]["username"] if data["created_by"] else None
    data["people"] = [p["name"] for p in data["people"]]
    return _json(data)


def _visible_contact(entity: Entity, mcp_user) -> Entity:
    fresh = base_contact_queryset(user=mcp_user).filter(pk=entity.pk).first()
    if fresh is None:
        raise ValueError(f"No person or company matches {entity.pk}.")
    return fresh


def _contact(entity: Entity, mcp_user, *, detail: bool = False, limit: int = 30) -> dict:
    fresh = _visible_contact(entity, mcp_user)
    data = dict(ContactSerializer(fresh, context={"user": mcp_user}).data)
    data.pop("slug", None)
    tab = "companies" if fresh.kind == EntityKind.COMPANY else "people"
    data["url"] = f"{settings.FRONTEND_URL}/crm?tab={tab}&c={fresh.id}"
    if detail:
        if fresh.kind == EntityKind.COMPANY:
            people = base_contact_queryset(user=mcp_user).filter(company=fresh)
            data["people"] = [
                {"id": p.id, "name": p.name, "position": p.position} for p in people
            ]
        leads = filter_leads({"entity": fresh.pk}, user=mcp_user)
        data["leads"] = [_lead_summary(lead) for lead in leads]
        updates = filter_updates({"entity": fresh.pk}, user=mcp_user)[:limit]
        data["updates"] = [_update(u, mcp_user) for u in updates]
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
    mcp_user=None,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {
        "search": query, "kind": kind, "project": _scope(project, mcp_user),
    }
    if company not in (None, ""):
        filters["company"] = _entity(company, EntityKind.COMPANY).pk
    rows = filter_contacts(filters, user=mcp_user)[: max(1, min(limit, MAX_LIST_LIMIT))]
    return [_contact(e, mcp_user) for e in rows]


def get_contact(
    contact: str | int, kind: str | None = None, limit: int = 30, mcp_user=None
) -> dict:
    return _contact(_entity(contact, kind), mcp_user, detail=True, limit=limit)


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
    mcp_user=None,
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
        entity, created = _visible_contact(_entity(text), mcp_user), False
        _guard(services.update_contact, entity, data)
    else:
        entity, created = _guard(
            services.create_contact, {"name": text, "kind": kind, **data}, viewer=mcp_user
        )
    # Rename after resolving: passing the new name to create_contact would
    # look *it* up and create a second entity.
    if rename_to:
        _guard(services.update_contact, entity, {"name": rename_to})
    if base_contact_queryset(user=mcp_user).filter(pk=entity.pk).exists():
        return {"created": created, **_contact(entity, mcp_user)}
    # Not on one of the caller's leads yet — it shows once it is.
    return {"created": created, "id": entity.id, "kind": entity.kind, "name": entity.name}


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
    mcp_user=None,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {
        "search": query,
        "stage": _stage(stage) if stage else None,
        "status": status,
        "project": _scope(project, mcp_user),
    }
    if contact not in (None, ""):
        filters["entity"] = _entity(contact).pk
    rows = filter_leads(filters, user=mcp_user)[: max(1, min(limit, MAX_LIST_LIMIT))]
    return [_lead_summary(lead) for lead in rows]


def get_lead(lead: str, limit: int = 50, mcp_user=None) -> dict[str, Any]:
    target = filter_leads(user=mcp_user).get(pk=_lead(lead, mcp_user).pk)
    data = _lead_summary(target)
    data["people"] = [
        {"id": p.id, "name": p.name, "position": p.position} for p in lead_people(target)
    ]
    steps = open_steps().filter(crm_update__lead=target).select_related("column")
    data["open_steps"] = [_step(t) for t in steps.prefetch_related("assignees")]
    updates = filter_updates({"lead": target.key}, user=mcp_user)[:limit]
    data["updates"] = [_update(u, mcp_user) for u in updates]
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
        data["project"] = _project(project, mcp_user, "crm") if project != "" else None
    if notes is not None:
        data["notes"] = notes
    if lost_reason is not None:
        data["lost_reason"] = lost_reason
    _guard(
        services.check_reach, mcp_user, "crm",
        project=data["project"] if "project" in data else services.UNSET,
        entities=[data.get("company")],
    )
    if lead:
        target = _lead(lead, mcp_user)
        _guard(services.update_lead, target, data)
    else:
        if not title:
            raise ValueError("A new lead needs a title (or pass `lead` to edit one).")
        _guard(services.check_reach, mcp_user, "crm", project=data.get("project"))
        target = _guard(services.create_lead, data, user=_reporter(mcp_user))
    return _lead_summary(filter_leads(user=mcp_user).get(pk=target.pk))


def delete_lead(lead: str, mcp_user=None) -> dict[str, Any]:
    target = _lead(lead, mcp_user)
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
    target = _lead(lead, mcp_user) if lead else None
    tagged = [_person(p) for p in people or []]
    linked = _meeting(meeting, mcp_user) if meeting else None
    _guard(
        services.check_reach, mcp_user, "crm",
        lead=target, lead_required=True, meeting=linked, entities=tagged,
    )
    update = _guard(
        services.post_update,
        data,
        user=reporter,
        lead=target,
        people=tagged,
        users=team,
        meeting=linked,
    )
    return _update(filter_updates(user=mcp_user).get(pk=update.pk), mcp_user)


def _update_row(update_id: int, mcp_user) -> Update:
    found = base_update_queryset(user=mcp_user).filter(pk=update_id).first()
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
    mcp_user=None,
) -> dict[str, Any]:
    target = _update_row(update_id, mcp_user)
    data = {"body": body, "kind": _kind(kind), "occurred_at": _aware(occurred_at)}
    kwargs: dict[str, Any] = {}
    if lead is not None:
        kwargs["lead"] = _lead(lead, mcp_user) if lead else None
    if meeting is not None:
        kwargs["meeting"] = _meeting(meeting, mcp_user) if meeting else None
    if people is not None:
        kwargs["people"] = [_person(p) for p in people]
    if users is not None:
        kwargs["users"] = [_user(u) for u in users]
    _guard(
        services.check_reach, mcp_user, "crm",
        lead=kwargs.get("lead", target.lead), lead_required=True,
        meeting=kwargs.get("meeting"), entities=kwargs.get("people", []),
    )
    _guard(services.edit_update, target, data, **kwargs)
    return _update(filter_updates(user=mcp_user).get(pk=target.pk), mcp_user)


def complete_next_step(task: str, done: bool = True, mcp_user=None) -> dict[str, Any]:
    steps = scope_for_caller(Task.objects.all(), mcp_user, "crm", "crm_update__lead__project")
    target = (
        steps.select_related("column", "project")
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


def delete_update(update_id: int, mcp_user=None) -> dict[str, Any]:
    services.delete_update(_update_row(update_id, mcp_user))
    return {"ok": True, "id": update_id}


def list_crm_activity(
    days: int = 14, limit: int = 100, project: str | None = None, mcp_user=None
) -> list[dict[str, Any]]:
    rows = filter_updates(
        {"days": max(1, days), "project": _scope(project, mcp_user)}, user=mcp_user
    )
    return [_update(u, mcp_user) for u in rows[: max(1, min(limit, MAX_LIST_LIMIT))]]


# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------


def _date(value: str | None, field: str):
    from django.utils.dateparse import parse_date

    if value in (None, ""):
        return None
    parsed = parse_date(str(value).strip()[:10])
    if parsed is None:
        raise ValueError(f"{field}: can't read {value!r} as a date (use 2026-12-05).")
    return parsed


def list_payments(
    status: str | None = None,
    type: str | None = None,
    project: str | None = None,
    company: str | int | None = None,
    lead: str | None = None,
    limit: int = 100,
    mcp_user=None,
) -> list[dict[str, Any]]:
    from .query import filter_payments
    from .serializers import payment_dict

    filters: dict[str, Any] = {
        "status": status, "type": type, "project": _scope(project, mcp_user, "billing"),
        "lead": lead,
    }
    if company not in (None, ""):
        filters["company"] = _entity(company, EntityKind.COMPANY).pk
    rows = filter_payments(filters, user=mcp_user)[: max(1, min(limit, MAX_LIST_LIMIT))]
    return [_json(payment_dict(p, user=mcp_user)) for p in rows]


def record_payment(
    payment_id: int | None = None,
    title: str | None = None,
    company: str | int | None = None,
    project: str | None = None,
    type: str | None = None,
    amount: float | None = None,
    due_on: str | None = None,
    paid_on: str | None = None,
    lead: str | None = None,
    licence: int | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    from decimal import Decimal

    from .query import filter_payments
    from .serializers import payment_dict

    data: dict[str, Any] = {}
    if title is not None:
        data["title"] = title
    if company not in (None, ""):
        # Existing companies only: a typo must not create a debtor.
        data["company"] = _entity(company, EntityKind.COMPANY)
    if project is not None:
        data["project"] = _project(project, mcp_user, "billing") if project != "" else None
    if type is not None:
        data["type"] = type.strip().lower().replace(" ", "_").replace("-", "_")
    if amount is not None:
        data["amount"] = Decimal(str(amount))
    if due_on is not None:
        data["due_on"] = _date(due_on, "due_on")
    if paid_on is not None:
        data["paid_on"] = _date(paid_on, "paid_on")
    if lead is not None:
        data["lead"] = _lead(lead, mcp_user, "billing") if lead != "" else None
    if licence is not None:
        data["licence"] = _licence(licence, mcp_user) if licence else None
    target = None
    if payment_id is not None:
        target = filter_payments(user=mcp_user).filter(pk=payment_id).first()
        if target is None:
            raise ValueError(f"No payment with id {payment_id}.")
    saved = _guard(services.save_payment, target, data, viewer=mcp_user)
    return _json(payment_dict(filter_payments(user=mcp_user).get(pk=saved.pk), user=mcp_user))


def _licence(ref: int, mcp_user):
    from .models import Licence

    row = scope_for_caller(Licence.objects.all(), mcp_user, "billing").filter(pk=ref).first()
    if row is None:
        raise ValueError(f"No licence with id {ref}.")
    return row


def list_licences(
    status: str | None = None,
    project: str | None = None,
    company: str | int | None = None,
    lead: str | None = None,
    limit: int = 100,
    mcp_user=None,
) -> list[dict[str, Any]]:
    from .query import filter_licences
    from .serializers import licence_dict

    filters: dict[str, Any] = {
        "status": status, "project": _scope(project, mcp_user, "billing"), "lead": lead,
    }
    if company not in (None, ""):
        filters["company"] = _entity(company, EntityKind.COMPANY).pk
    rows = filter_licences(filters, user=mcp_user)[: max(1, min(limit, MAX_LIST_LIMIT))]
    return [_json(licence_dict(lc, user=mcp_user)) for lc in rows]


def upsert_licence(
    licence_id: int | None = None,
    title: str | None = None,
    company: str | int | None = None,
    project: str | None = None,
    starts_on: str | None = None,
    ends_on: str | None = None,
    lead: str | None = None,
    payments: list[dict[str, Any]] | None = None,
    mcp_user=None,
) -> dict[str, Any]:
    from decimal import Decimal

    from .query import filter_licences
    from .serializers import licence_dict

    data: dict[str, Any] = {}
    if title is not None:
        data["title"] = title
    if company not in (None, ""):
        data["company"] = _entity(company, EntityKind.COMPANY)
    if project is not None:
        data["project"] = _project(project, mcp_user, "billing") if project != "" else None
    if starts_on is not None:
        data["starts_on"] = _date(starts_on, "starts_on")
    if ends_on is not None:
        data["ends_on"] = _date(ends_on, "ends_on")
    if lead is not None:
        data["lead"] = _lead(lead, mcp_user, "billing") if lead != "" else None
    target = _licence(licence_id, mcp_user) if licence_id is not None else None
    plan = []
    for row in payments or []:
        if target is not None:
            raise ValueError("`payments` only applies when creating a licence; use record_payment(licence=…).")
        plan.append({
            "type": str(row.get("type", "")).strip().lower().replace(" ", "_").replace("-", "_"),
            "amount": Decimal(str(row.get("amount"))),
            "due_on": _date(row.get("due_on"), "due_on"),
            "paid_on": _date(row.get("paid_on"), "paid_on"),
        })
    saved = _guard(services.save_licence, target, data, plan=plan, viewer=mcp_user)
    return _json(licence_dict(filter_licences(user=mcp_user).get(pk=saved.pk), user=mcp_user))
