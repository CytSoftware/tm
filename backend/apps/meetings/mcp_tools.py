"""Sync implementations behind the meeting MCP tools.

``apps/mcp_server/server.py`` holds the thin async ``@mcp.tool()`` wrappers
(their docstrings are what an agent reads); this module does the work. It adds
**no logic of its own** — every read goes through ``query.py`` / ``related.py``
and every write through ``services.py``, the same modules the REST API uses,
so a meeting pushed over MCP is indistinguishable from one posted to
``/api/meetings/``. What lives here is only the translation between an
agent-friendly flat argument list and those modules.
"""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.db.models import Count, Q
from rest_framework.exceptions import ValidationError

from apps.tasks.models import Task, TransitionSource

from . import services
from .broadcast import broadcast_meeting_event
from .models import Entity, EntityKind, EntityRole, Meeting
from .query import base_meeting_queryset, filter_meetings
from .related import related_meetings
from .serializers import (
    EntitySerializer,
    MeetingCurateSerializer,
    MeetingDetailSerializer,
    MeetingListSerializer,
    MeetingUpsertSerializer,
)

MAX_LIST_LIMIT = 200

_FILTER_KEYS = (
    "project",
    "category",
    "person",
    "company",
    "entity",
    "tag",
    "date_from",
    "date_to",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def meeting_url(meeting: Meeting) -> str:
    return f"{settings.FRONTEND_URL}/meetings?m={meeting.key}"


def _plain(data: Any) -> Any:
    """DRF ``ReturnDict``/``ReturnList`` → plain JSON-able containers."""
    if isinstance(data, dict):
        return {k: _plain(v) for k, v in data.items()}
    if isinstance(data, (list, tuple)):
        return [_plain(v) for v in data]
    return data


def _validated(serializer_cls, data: dict[str, Any]) -> dict[str, Any]:
    """Run the same serializer the REST API uses; turn DRF's nested error
    dict into one readable line, since that is all an agent gets to see."""
    serializer = serializer_cls(data=data)
    try:
        serializer.is_valid(raise_exception=True)
    except ValidationError as exc:
        raise ValueError(f"Invalid meeting data: {_flatten_errors(exc.detail)}")
    return serializer.validated_data


def _flatten_errors(detail: Any, prefix: str = "") -> str:
    if isinstance(detail, dict):
        return "; ".join(
            _flatten_errors(v, f"{prefix}{k}.") for k, v in detail.items()
        )
    if isinstance(detail, list):
        if detail and all(isinstance(d, (dict, list)) for d in detail):
            return "; ".join(
                _flatten_errors(d, f"{prefix.rstrip('.')}[{i}].")
                for i, d in enumerate(detail)
                if d
            )
        return f"{prefix.rstrip('.')}: {' '.join(str(d) for d in detail)}"
    return f"{prefix.rstrip('.')}: {detail}"


def _get_meeting(ref: str) -> Meeting:
    """Accept the human key (``MTG-014``) or the pipeline's recording stem."""
    ref = (ref or "").strip()
    meeting = (
        base_meeting_queryset()
        .filter(Q(key__iexact=ref) | Q(stem=ref))
        .first()
    )
    if meeting is None:
        raise ValueError(f"Meeting {ref!r} not found (pass a key like MTG-014 or a stem).")
    return meeting


def _get_entity(ref: str | int, kind: str | None = None) -> Entity:
    """Accept an id, or a name / slug / alias (``kind`` disambiguates when a
    person and a company share a name)."""
    qs = Entity.objects.all()
    if kind:
        qs = qs.filter(kind=kind)
    text = str(ref).strip()
    if text.isdigit():
        found = list(qs.filter(pk=int(text)))
    else:
        slug = services.entity_slug(text)
        found = list(qs.filter(Q(slug=slug) | Q(name__iexact=text)))
        if not found:
            found = [
                e
                for e in qs.exclude(aliases=[])
                if slug in {services.entity_slug(a) for a in e.aliases}
            ]
    if not found:
        raise ValueError(f"No person or company matches {ref!r}.")
    if len(found) > 1:
        raise ValueError(
            f"{ref!r} is both a person and a company — pass kind='person' or 'company'."
        )
    return found[0]


def _detail(meeting: Meeting, *, include_transcript: bool = True) -> dict[str, Any]:
    fresh = base_meeting_queryset().get(pk=meeting.pk)
    data = _plain(MeetingDetailSerializer(fresh).data)
    if not include_transcript:
        data["transcript_chars"] = len(data.pop("transcript_md") or "")
    data.pop("snippet", None)
    data["url"] = meeting_url(fresh)
    return data


def _summaries(meetings, *, search: str = "") -> list[dict[str, Any]]:
    rows = _plain(
        MeetingListSerializer(meetings, many=True, context={"search": search}).data
    )
    for row in rows:
        if not search:
            row.pop("snippet", None)
        row["url"] = f"{settings.FRONTEND_URL}/meetings?m={row['key']}"
    return rows


def _entity_specs(
    people: list[Any] | None,
    companies: list[Any] | None,
    mentioned_people: list[Any] | None,
    mentioned_companies: list[Any] | None,
) -> list[dict[str, Any]] | None:
    """Flat name lists → the ``entities`` shape the serializers take.

    Each entry is a name, or for a person ``{"name": ..., "company": ...}`` to
    also record their employer. Returns ``None`` when nothing was passed at
    all, so "not provided" stays distinguishable from "provided, empty".
    """
    groups = (
        (people, EntityKind.PERSON, EntityRole.ATTENDEE),
        (companies, EntityKind.COMPANY, EntityRole.ATTENDEE),
        (mentioned_people, EntityKind.PERSON, EntityRole.MENTIONED),
        (mentioned_companies, EntityKind.COMPANY, EntityRole.MENTIONED),
    )
    if all(g[0] is None for g in groups):
        return None
    specs: list[dict[str, Any]] = []
    for entries, kind, role in groups:
        for entry in entries or []:
            if isinstance(entry, dict):
                spec = {"kind": kind, "role": role, "name": entry.get("name", "")}
                if entry.get("company") and kind == EntityKind.PERSON:
                    spec["company"] = entry["company"]
            else:
                spec = {"kind": kind, "role": role, "name": str(entry)}
            specs.append(spec)
    return specs


def _action_item_specs(items: list[Any] | None) -> list[dict[str, Any]] | None:
    if items is None:
        return None
    return [i if isinstance(i, dict) else {"text": str(i)} for i in items]


def _drop_none(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if v is not None}


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def _filters(filters: dict[str, Any]) -> dict[str, Any]:
    chosen = {k: filters[k] for k in _FILTER_KEYS if filters.get(k) not in (None, "")}
    # query.py matches entities by id or slug; agents think in names.
    for key in ("person", "company", "entity"):
        value = str(chosen.get(key, ""))
        if value and not value.isdigit():
            chosen[key] = services.entity_slug(value)
    return chosen


def list_meetings(limit: int = 50, **filters: Any) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), MAX_LIST_LIMIT))
    chosen = _filters(filters)
    return _summaries(filter_meetings(chosen, light=True)[:limit])


def search_meetings(query: str, limit: int = 20, **filters: Any) -> list[dict[str, Any]]:
    query = (query or "").strip()
    if not query:
        raise ValueError("query is required — use list_meetings to browse.")
    limit = max(1, min(int(limit), MAX_LIST_LIMIT))
    chosen = _filters(filters)
    chosen["search"] = query
    return _summaries(filter_meetings(chosen)[:limit], search=query)


def get_meeting(meeting: str, include_transcript: bool = False) -> dict[str, Any]:
    return _detail(_get_meeting(meeting), include_transcript=include_transcript)


def get_related_meetings(meeting: str, limit: int = 12) -> list[dict[str, Any]]:
    rows = related_meetings(_get_meeting(meeting), limit=max(1, min(int(limit), 50)))
    for row in rows:
        row["started_at"] = row["started_at"].isoformat()
        row["url"] = f"{settings.FRONTEND_URL}/meetings?m={row['key']}"
    return rows


def list_meeting_entities(
    kind: str | None = None, search: str | None = None, limit: int = 200
) -> list[dict[str, Any]]:
    qs = Entity.objects.select_related("company").annotate(
        meeting_count=Count("meetings", distinct=True)
    )
    if kind:
        qs = qs.filter(kind=kind)
    if search:
        qs = qs.filter(name__icontains=search.strip())
    qs = qs.order_by("-meeting_count", "name")[: max(1, min(int(limit), 500))]
    return _plain(EntitySerializer(qs, many=True).data)


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def upsert_meeting(
    stem: str,
    *,
    people: list[Any] | None = None,
    companies: list[Any] | None = None,
    mentioned_people: list[Any] | None = None,
    mentioned_companies: list[Any] | None = None,
    action_items: list[Any] | None = None,
    mcp_user=None,
    **fields: Any,
) -> dict[str, Any]:
    data = _drop_none(
        {
            "stem": stem,
            **fields,
            "entities": _entity_specs(
                people, companies, mentioned_people, mentioned_companies
            ),
            "action_items": _action_item_specs(action_items),
        }
    )
    validated = _validated(MeetingUpsertSerializer, data)

    # Anything above this id after the write was created by it. Reported back
    # so the caller can spot a near-duplicate ("Ali" vs "Ali K.") right away.
    # A hint, not state: two simultaneous pushes can each report the other's.
    newest_before = Entity.objects.order_by("-pk").values_list("pk", flat=True).first() or 0
    meeting, created = services.upsert_meeting(validated, user=mcp_user)
    broadcast_meeting_event(
        "meeting.created" if created else "meeting.updated", {"key": meeting.key}
    )

    result = _detail(meeting, include_transcript=False)
    result.pop("brief_md", None)
    result.pop("source_meta", None)
    result["created"] = created
    result["new_entities"] = [
        {"id": e.pk, "kind": e.kind, "name": e.name}
        for e in Entity.objects.filter(pk__gt=newest_before).order_by("pk")
    ]
    return result


def update_meeting(
    meeting: str,
    *,
    people: list[Any] | None = None,
    companies: list[Any] | None = None,
    mentioned_people: list[Any] | None = None,
    mentioned_companies: list[Any] | None = None,
    clear_project: bool = False,
    **fields: Any,
) -> dict[str, Any]:
    target = _get_meeting(meeting)
    data = _drop_none(
        {
            **fields,
            "entities": _entity_specs(
                people, companies, mentioned_people, mentioned_companies
            ),
        }
    )
    if clear_project:
        data["project"] = None
    if not data:
        raise ValueError("Nothing to update.")
    serializer = MeetingCurateSerializer(data=data, partial=True)
    try:
        serializer.is_valid(raise_exception=True)
    except ValidationError as exc:
        raise ValueError(f"Invalid meeting data: {_flatten_errors(exc.detail)}")
    services.curate_meeting(target, serializer.validated_data)
    broadcast_meeting_event("meeting.updated", {"key": target.key})
    return _detail(target, include_transcript=False)


def delete_meeting(meeting: str) -> dict[str, Any]:
    target = _get_meeting(meeting)
    key, title = target.key, target.title
    target.delete()
    broadcast_meeting_event("meeting.deleted", {"key": key})
    return {"deleted": key, "title": title}


def set_meeting_action_item(meeting: str, item_id: str, done: bool) -> dict[str, Any]:
    target = _get_meeting(meeting)
    services.set_action_item_done(target, item_id, done)
    broadcast_meeting_event("meeting.updated", {"key": target.key})
    return _detail(target, include_transcript=False)


def create_task_from_meeting_action_item(
    meeting: str, item_id: str, project: str | int | None = None, mcp_user=None
) -> dict[str, Any]:
    # Local import: apps.mcp_server.tools imports half the project.
    from apps.mcp_server.tools import _resolve_reporter_for_mcp, _task_dict

    target = _get_meeting(meeting)
    task = services.create_task_from_action_item(
        target,
        item_id,
        user=_resolve_reporter_for_mcp(mcp_user),
        project=project,
        source=TransitionSource.MCP,
    )
    broadcast_meeting_event("meeting.updated", {"key": target.key})
    return {"task": _task_dict(task), "meeting": target.key}


def link_meeting_task(meeting: str, task: str, unlink: bool = False) -> dict[str, Any]:
    target = _get_meeting(meeting)
    try:
        task_obj = Task.objects.get(key__iexact=task.strip())
    except Task.DoesNotExist:
        raise ValueError(f"Task {task!r} not found.")
    (services.unlink_task if unlink else services.link_task)(target, task_obj)
    broadcast_meeting_event("meeting.updated", {"key": target.key})
    return _detail(target, include_transcript=False)


def link_meetings(
    meeting: str,
    other: str,
    kind: str = "follow_up",
    note: str = "",
    unlink: bool = False,
) -> list[dict[str, Any]]:
    a, b = _get_meeting(meeting), _get_meeting(other)
    if unlink:
        services.unlink_meetings(a, b)
    else:
        services.link_meetings(a, b, kind=kind, note=note)
    for m in (a, b):
        broadcast_meeting_event("meeting.updated", {"key": m.key})
    return get_related_meetings(a.key)


def update_meeting_entity(
    entity: str | int,
    kind: str | None = None,
    name: str | None = None,
    aliases: list[str] | None = None,
    wiki_slug: str | None = None,
    company: str | None = None,
) -> dict[str, Any]:
    target = _get_entity(entity, kind)
    if name is not None:
        if not name.strip():
            raise ValueError("name can't be blank.")
        # The old name keeps resolving, so the pipeline doesn't recreate it.
        if target.name not in target.aliases and target.name != name.strip():
            target.aliases = [*target.aliases, target.name]
        target.name = name.strip()
        # Keep the slug in step, or a push of the *new* name would miss this
        # row (resolution is slug-then-alias) and create a duplicate.
        slug = services.entity_slug(target.name)
        clash = Entity.objects.filter(kind=target.kind, slug=slug).exclude(pk=target.pk)
        if clash.exists():
            raise ValueError(
                f"{target.name!r} already exists (id {clash.first().pk}) — "
                "use merge_meeting_entities instead of renaming."
            )
        target.slug = slug
    if aliases is not None:
        target.aliases = [a.strip() for a in aliases if a and a.strip()]
    if wiki_slug is not None:
        target.wiki_slug = wiki_slug.strip()
    if company is not None:
        if target.kind != EntityKind.PERSON:
            raise ValueError("Only a person can belong to a company.")
        target.company = (
            services.resolve_entity(EntityKind.COMPANY, company) if company.strip() else None
        )
    target.save()
    broadcast_meeting_event("entity.updated", {"id": target.pk})
    return _plain(EntitySerializer(target).data)


def merge_meeting_entities(
    source: str | int, into: str | int, kind: str | None = None
) -> dict[str, Any]:
    merged = services.merge_entities(_get_entity(source, kind), _get_entity(into, kind))
    broadcast_meeting_event("entity.updated", {"id": merged.pk})
    data = _plain(EntitySerializer(merged).data)
    data["meeting_count"] = merged.meetings.count()
    return data
