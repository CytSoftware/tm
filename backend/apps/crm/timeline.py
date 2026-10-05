"""History, derived at read time — one contact's timeline, or the whole CRM's
recent activity.

Meetings are already linked to their entities, touchpoints carry their own,
and follow-ups are tasks — so both views are a union, never a copy. A
company's timeline includes its people's items.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.db.models import Q
from django.utils import timezone

from apps.meetings.models import Entity, EntityKind, EntityRole, Meeting
from apps.meetings.query import BODY_FIELDS

from .models import FollowUp, Touchpoint
from .query import CLOSED_COLUMN_KINDS, CRM_RELATIONSHIPS

DEFAULT_LIMIT = 100


def _ref(e: Entity) -> dict[str, Any]:
    return {"id": e.id, "kind": e.kind, "name": e.name}


def _meeting_item(m: Meeting, only: set[int] | None = None) -> dict[str, Any]:
    links = [link for link in m.entity_links.all() if link.role == EntityRole.ATTENDEE]
    if only is not None:
        links = [link for link in links if link.entity_id in only]
    return {
        "type": "meeting",
        "at": m.started_at,
        "title": m.title,
        "summary": m.summary,
        "key": m.key,
        "category": m.category,
        "gshr_url": m.gshr_url,
        "duration_seconds": m.duration_seconds,
        "people": [link.entity.name for link in links],
        "entities": [_ref(link.entity) for link in links],
    }


def _touchpoint_item(t: Touchpoint) -> dict[str, Any]:
    entities = list(t.entities.all())
    return {
        "type": "touchpoint",
        "at": t.occurred_at,
        "id": t.id,
        "kind": t.kind,
        "direction": t.direction,
        "summary": t.summary,
        "source": t.source,
        "deal": t.deal.key if t.deal_id else None,
        "people": [e.name for e in entities],
        "entities": [_ref(e) for e in entities],
        "created_by": t.created_by.username if t.created_by_id else None,
    }


def _follow_up_item(f: FollowUp) -> dict[str, Any]:
    task = f.task
    return {
        "type": "follow_up",
        # When it was closed; updated_at is the move into Done.
        "at": task.updated_at,
        "title": task.title,
        "key": task.key,
        "status": task.column.kind if task.column_id else None,
        "deal": f.deal.key if f.deal_id else None,
        "entities": [_ref(f.entity)],
    }


def _sorted(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    items.sort(key=lambda i: i["at"], reverse=True)
    return items[:limit]


def _ids(entity: Entity) -> list[int]:
    ids = [entity.pk]
    if entity.kind == EntityKind.COMPANY:
        ids += list(entity.people.values_list("pk", flat=True))
    return ids


def entity_timeline(entity: Entity, *, limit: int = DEFAULT_LIMIT) -> list[dict[str, Any]]:
    ids = _ids(entity)
    id_set = set(ids)
    items: list[dict[str, Any]] = []

    meetings = (
        Meeting.objects.filter(entity_links__entity_id__in=ids)
        .distinct()
        .defer(*BODY_FIELDS)
        .prefetch_related("entity_links__entity")
        .order_by("-started_at")[:limit]
    )
    items += [_meeting_item(m, only=id_set) for m in meetings]

    touchpoints = (
        Touchpoint.objects.filter(entities__in=ids)
        .distinct()
        .select_related("deal", "created_by")
        .prefetch_related("entities")
        .order_by("-occurred_at")[:limit]
    )
    items += [_touchpoint_item(t) for t in touchpoints]

    # Open follow-ups are shown in their own section, not the history.
    follow_ups = (
        FollowUp.objects.filter(entity_id__in=ids, task__column__kind__in=CLOSED_COLUMN_KINDS)
        .select_related("task__column", "deal", "entity")
        .order_by("-task__updated_at")[:limit]
    )
    items += [_follow_up_item(f) for f in follow_ups]
    return _sorted(items, limit)


def crm_activity(*, days: int = 14, limit: int = DEFAULT_LIMIT) -> list[dict[str, Any]]:
    """Everything that happened with CRM contacts in the last ``days``:
    recorded meetings they attended, touchpoints, and follow-ups closed."""
    since = timezone.now() - timedelta(days=max(1, days))
    in_crm = Q(relationship__in=CRM_RELATIONSHIPS)
    crm_ids = set(Entity.objects.filter(in_crm).values_list("pk", flat=True))
    items: list[dict[str, Any]] = []

    meetings = (
        Meeting.objects.filter(
            started_at__gte=since,
            entity_links__entity_id__in=crm_ids,
            entity_links__role=EntityRole.ATTENDEE,
        )
        .distinct()
        .defer(*BODY_FIELDS)
        .prefetch_related("entity_links__entity")
        .order_by("-started_at")[:limit]
    )
    items += [_meeting_item(m, only=crm_ids) for m in meetings]

    touchpoints = (
        Touchpoint.objects.filter(occurred_at__gte=since)
        .select_related("deal", "created_by")
        .prefetch_related("entities")
        .order_by("-occurred_at")[:limit]
    )
    items += [_touchpoint_item(t) for t in touchpoints]

    follow_ups = (
        FollowUp.objects.filter(
            task__updated_at__gte=since, task__column__kind__in=CLOSED_COLUMN_KINDS
        )
        .select_related("task__column", "deal", "entity")
        .order_by("-task__updated_at")[:limit]
    )
    items += [_follow_up_item(f) for f in follow_ups]
    return _sorted(items, limit)
