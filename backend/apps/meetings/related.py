"""How meetings connect: the "related meetings" ranking and the graph.

Connections are **derived** from what meetings share — entities, project,
tags — rather than stored, so they stay correct as entities are merged and
meetings re-categorised. The only stored edge is ``MeetingLink``, for what
metadata can't infer ("this was the follow-up to that call").
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from django.db.models import Q

from .models import (
    EntityKind,
    EntityRole,
    Meeting,
    MeetingEntity,
    MeetingLink,
)
from .query import BODY_FIELDS, filter_meetings

#: A company, or a person who attended both meetings, is a strong tie. Someone
#: merely mentioned is a weak one.
WEIGHT_STRONG_ENTITY = 3
WEIGHT_WEAK_ENTITY = 1
WEIGHT_PROJECT = 2
WEIGHT_TAG = 1


def related_meetings(meeting: Meeting, *, limit: int = 12) -> list[dict[str, Any]]:
    """Other meetings ranked by what they share with ``meeting``.

    Each hit carries its ``reasons`` so the UI can say *why* it's related.
    Explicitly linked meetings are pinned above everything derived.
    """
    scores: dict[int, int] = defaultdict(int)
    reasons: dict[int, list[str]] = defaultdict(list)

    own = {
        link.entity_id: link
        for link in meeting.entity_links.select_related("entity")
    }
    if own:
        shared = MeetingEntity.objects.filter(entity_id__in=own.keys()).exclude(
            meeting_id=meeting.pk
        )
        for other in shared:
            mine = own[other.entity_id]
            strong = mine.entity.kind == EntityKind.COMPANY or (
                mine.role == EntityRole.ATTENDEE
                and other.role == EntityRole.ATTENDEE
            )
            scores[other.meeting_id] += (
                WEIGHT_STRONG_ENTITY if strong else WEIGHT_WEAK_ENTITY
            )
            reasons[other.meeting_id].append(mine.entity.name)

    if meeting.project_id:
        same_project = Meeting.objects.filter(project_id=meeting.project_id)
        for pk in same_project.exclude(pk=meeting.pk).values_list("pk", flat=True):
            scores[pk] += WEIGHT_PROJECT
            reasons[pk].append(meeting.project.name)

    tag_ids = list(meeting.tags.values_list("pk", flat=True))
    if tag_ids:
        tagged = Meeting.tags.through.objects.filter(tag_id__in=tag_ids).exclude(
            meeting_id=meeting.pk
        )
        for row in tagged.select_related("tag"):
            scores[row.meeting_id] += WEIGHT_TAG
            reasons[row.meeting_id].append(f"#{row.tag.name}")

    pinned: dict[int, str] = {}
    links = MeetingLink.objects.filter(
        Q(from_meeting=meeting) | Q(to_meeting=meeting)
    )
    for link in links:
        other_id = (
            link.to_meeting_id
            if link.from_meeting_id == meeting.pk
            else link.from_meeting_id
        )
        pinned[other_id] = link.kind
        scores.setdefault(other_id, 0)

    ranked = sorted(scores, key=lambda pk: (pk not in pinned, -scores[pk]))[:limit]
    by_id = Meeting.objects.select_related("project").in_bulk(ranked)
    out = []
    for pk in ranked:
        other = by_id.get(pk)
        if other is None:
            continue
        out.append(
            {
                "key": other.key,
                "title": other.title,
                "started_at": other.started_at,
                "category": other.category,
                "score": scores[pk],
                "link_kind": pinned.get(pk),
                "reasons": list(dict.fromkeys(reasons[pk])),
            }
        )
    return out


def build_graph(
    filters: dict[str, Any] | None = None,
    *,
    include_mentioned: bool = False,
    include_projects: bool = True,
) -> dict[str, list[dict[str, Any]]]:
    """Nodes and edges for the meetings graph, scoped by the list filters.

    There are deliberately **no derived meeting↔meeting edges**: two meetings
    that share a person are already connected *through* that person's node,
    and drawing the direct edge as well turns the picture into a hairball.
    """
    meetings = list(filter_meetings(filters).defer(*BODY_FIELDS))
    meeting_ids = {m.pk for m in meetings}
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    entities: dict[int, Any] = {}
    degree: dict[int, int] = defaultdict(int)
    projects: dict[int, Any] = {}

    for m in meetings:
        nodes.append(
            {
                "id": f"m:{m.key}",
                "type": "meeting",
                "key": m.key,
                "label": m.title,
                "category": m.category,
                "started_at": m.started_at,
            }
        )
        for link in m.entity_links.all():  # prefetched
            if link.role == EntityRole.MENTIONED and not include_mentioned:
                continue
            entities[link.entity_id] = link.entity
            degree[link.entity_id] += 1
            edges.append(
                {
                    "source": f"m:{m.key}",
                    "target": f"e:{link.entity_id}",
                    "kind": link.role,
                }
            )
        if include_projects and m.project_id:
            projects[m.project_id] = m.project
            edges.append(
                {
                    "source": f"m:{m.key}",
                    "target": f"p:{m.project_id}",
                    "kind": "project",
                }
            )

    # person → company, pulling the company in even if no meeting tagged it.
    for entity in list(entities.values()):
        if entity.company_id is None:
            continue
        if entity.company_id not in entities:
            entities[entity.company_id] = entity.company
        edges.append(
            {
                "source": f"e:{entity.pk}",
                "target": f"e:{entity.company_id}",
                "kind": "works_at",
            }
        )

    for entity in entities.values():
        nodes.append(
            {
                "id": f"e:{entity.pk}",
                "type": entity.kind,
                "entity_id": entity.pk,
                "slug": entity.slug,
                "label": entity.name,
                "meeting_count": degree.get(entity.pk, 0),
            }
        )
    for project in projects.values():
        nodes.append(
            {
                "id": f"p:{project.pk}",
                "type": "project",
                "project_id": project.pk,
                "label": project.name,
                "color": project.color,
            }
        )

    explicit = MeetingLink.objects.filter(
        from_meeting_id__in=meeting_ids, to_meeting_id__in=meeting_ids
    ).select_related("from_meeting", "to_meeting")
    for link in explicit:
        edges.append(
            {
                "source": f"m:{link.from_meeting.key}",
                "target": f"m:{link.to_meeting.key}",
                "kind": link.kind,
            }
        )
    return {"nodes": nodes, "edges": edges}
