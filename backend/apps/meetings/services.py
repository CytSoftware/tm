"""Write-side logic for meetings, shared by the REST API and the MCP tools.

The rule that shapes this module: **a pipeline re-push must never undo human
curation.** The pipeline re-ingests meetings as extraction improves, while
people fix categories, merge duplicate entities and tick off action items in
the UI. ``upsert_meeting`` therefore splits fields by owner — see
``PIPELINE_FIELDS`` / ``CURATED_FIELDS``.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Iterable

from django.db import transaction
from django.utils.text import slugify

from apps.tasks.models import Project, Task, TransitionEvent, TransitionSource
from apps.tasks.broadcast import broadcast_task_event
from apps.tasks.notifications import notify_task_event
from apps.tasks.transitions import record_transition

from .models import (
    Entity,
    EntityKind,
    EntityRole,
    Meeting,
    MeetingCategory,
    MeetingEntity,
    MeetingRoute,
    MeetingTask,
    Tag,
)

#: Always overwritten when present in an upsert payload.
PIPELINE_FIELDS = (
    "transcript_md",
    "brief_md",
    "brief_html",
    "summary",
    "duration_seconds",
    "speaker_count",
    "language",
    "source_meta",
    "gshr_url",
)

#: Written on create; on a re-push only with ``overwrite_metadata`` (or when
#: the stored value is still empty, so a better later extraction can fill it).
CURATED_FIELDS = ("title", "category", "started_at", "project")


class MeetingError(ValueError):
    """A write was refused for a reason the caller should be told about."""


# ---------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------


def entity_slug(name: str) -> str:
    return slugify(name, allow_unicode=True)


def resolve_entity(kind: str, name: str) -> Entity:
    """Find the entity ``name`` refers to, creating it if it's new.

    Match order: slug, then any alias. Aliases are compared slugified so
    "Ali K." and "ali k" land on the same row.
    """
    name = (name or "").strip()
    slug = entity_slug(name)
    if not slug:
        raise MeetingError(f"Entity name {name!r} is empty.")
    found = Entity.objects.filter(kind=kind, slug=slug).first()
    if found:
        return found
    # Python-side alias scan: entity counts are tiny, and JSON containment
    # isn't portable across SQLite/Postgres.
    for candidate in Entity.objects.filter(kind=kind).exclude(aliases=[]):
        if slug in {entity_slug(a) for a in candidate.aliases}:
            return candidate
    return Entity.objects.create(kind=kind, name=name, slug=slug)


def resolve_project(ref: Any) -> Project | None:
    if ref in (None, ""):
        return None
    if isinstance(ref, Project):
        return ref
    try:
        if isinstance(ref, int) or str(ref).isdigit():
            return Project.objects.get(pk=int(ref))
        return Project.objects.get(prefix__iexact=str(ref))
    except Project.DoesNotExist:
        raise MeetingError(f"Project {ref!r} not found.")


def _link_entities(
    meeting: Meeting, specs: Iterable[dict[str, Any]], *, replace: bool
) -> None:
    """Attach entities to a meeting.

    ``replace=False`` (pipeline) is additive — nothing is ever removed, and an
    existing link is only ever *upgraded* from mentioned to attendee.
    ``replace=True`` (a person editing in the UI) makes the set exact.
    """
    wanted: dict[int, str] = {}
    for spec in specs:
        entity = resolve_entity(spec["kind"], spec["name"])
        company_name = spec.get("company")
        if (
            company_name
            and entity.kind == EntityKind.PERSON
            and entity.company_id is None
        ):
            entity.company = resolve_entity(EntityKind.COMPANY, company_name)
            entity.save(update_fields=["company", "updated_at"])
        role = spec.get("role") or EntityRole.ATTENDEE
        if wanted.get(entity.id) != EntityRole.ATTENDEE:
            wanted[entity.id] = role

    existing = {link.entity_id: link for link in meeting.entity_links.all()}
    for entity_id, role in wanted.items():
        link = existing.get(entity_id)
        if link is None:
            MeetingEntity.objects.create(
                meeting=meeting, entity_id=entity_id, role=role
            )
        elif link.role != role and (replace or role == EntityRole.ATTENDEE):
            link.role = role
            link.save(update_fields=["role"])
    if replace:
        meeting.entity_links.exclude(entity_id__in=wanted.keys()).delete()


def _set_tags(meeting: Meeting, names: Iterable[str], *, replace: bool) -> None:
    cleaned = {n.strip().lower()[:64] for n in names if n and n.strip()}
    tags = [Tag.objects.get_or_create(name=n)[0] for n in sorted(cleaned)]
    if replace:
        meeting.tags.set(tags)
    else:
        meeting.tags.add(*tags)


@transaction.atomic
def merge_entities(source: Entity, target: Entity) -> Entity:
    """Fold ``source`` into ``target`` and delete it."""
    if source.pk == target.pk:
        raise MeetingError("Cannot merge an entity into itself.")
    if source.kind != target.kind:
        raise MeetingError("Can only merge entities of the same kind.")

    target_links = {l.meeting_id: l for l in target.meeting_links.all()}
    for link in source.meeting_links.all():
        kept = target_links.get(link.meeting_id)
        if kept is None:
            link.entity = target
            link.save(update_fields=["entity"])
            continue
        # Both were on this meeting — keep the stronger role.
        if link.role == EntityRole.ATTENDEE and kept.role != EntityRole.ATTENDEE:
            kept.role = EntityRole.ATTENDEE
            kept.save(update_fields=["role"])
        link.delete()

    Entity.objects.filter(company=source).update(company=target)
    if target.company_id is None and source.company_id not in (None, target.pk):
        target.company_id = source.company_id
    if not target.wiki_slug:
        target.wiki_slug = source.wiki_slug
    aliases = list(target.aliases)
    for alias in [source.name, *source.aliases]:
        if alias and alias != target.name and alias not in aliases:
            aliases.append(alias)
    target.aliases = aliases
    source.delete()
    target.save()
    return target


# ---------------------------------------------------------------------------
# Action items
# ---------------------------------------------------------------------------


def action_item_id(text: str) -> str:
    """Stable id from the item's text, so a re-push finds the same item even
    if the pipeline doesn't send ids."""
    normalized = re.sub(r"\W+", " ", text.lower()).strip()
    return hashlib.sha1(normalized.encode()).hexdigest()[:12]


def merge_action_items(
    existing: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Refresh text/owner from the pipeline; keep ``done`` and ``task_key``.

    Items the pipeline no longer reports are kept only if someone acted on
    them — a ticked or task-linked item shouldn't vanish on re-extraction.
    """
    by_id = {item["id"]: item for item in existing}
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in incoming:
        text = (raw.get("text") or "").strip()
        if not text:
            continue
        item_id = str(raw.get("id") or action_item_id(text))
        if item_id in seen:
            continue
        seen.add(item_id)
        prior = by_id.get(item_id, {})
        merged.append(
            {
                "id": item_id,
                "text": text,
                "owner": (raw.get("owner") or prior.get("owner") or "").strip(),
                "done": bool(prior.get("done", raw.get("done", False))),
                "task_key": prior.get("task_key") or None,
            }
        )
    for item in existing:
        if item["id"] not in seen and (item.get("done") or item.get("task_key")):
            merged.append(item)
    return merged


def find_action_item(meeting: Meeting, item_id: str) -> dict[str, Any]:
    for item in meeting.action_items:
        if item.get("id") == item_id:
            return item
    raise MeetingError(f"Action item {item_id!r} not found on {meeting.key}.")


@transaction.atomic
def set_action_item_done(meeting: Meeting, item_id: str, done: bool) -> Meeting:
    meeting = Meeting.objects.select_for_update().get(pk=meeting.pk)
    find_action_item(meeting, item_id)["done"] = bool(done)
    meeting.save(update_fields=["action_items", "updated_at"])
    return meeting


@transaction.atomic
def create_task_from_action_item(
    meeting: Meeting,
    item_id: str,
    *,
    user,
    project: Any = None,
    source: str = TransitionSource.USER,
) -> Task:
    """Turn an action item into a real task and link it to the meeting.

    Deliberately manual: LLM-extracted items are too noisy to land on the
    board unreviewed. Runs the same side effects as every other task create
    path (transition log, board broadcast, notifications/webhooks).
    """
    meeting = Meeting.objects.select_for_update().get(pk=meeting.pk)
    item = find_action_item(meeting, item_id)
    if item.get("task_key"):
        raise MeetingError(f"Already linked to {item['task_key']}.")
    if not getattr(user, "is_authenticated", False):
        # Task.reporter is required; an unattributed credential can't file one.
        raise MeetingError("Creating a task needs an identified user.")
    proj = resolve_project(project) or meeting.project
    if proj is None:
        raise MeetingError("Pick a project — this meeting isn't linked to one.")
    column = (
        proj.columns.filter(is_done=False).order_by("order").first()
        or proj.columns.order_by("order").first()
    )
    if column is None:
        raise MeetingError(f"Project {proj.prefix} has no columns.")

    task = Task(
        project=proj,
        column=column,
        title=item["text"][:200],
        description=f"From meeting {meeting.key} — {meeting.title}",
        reporter=user,
    )
    task.save()
    MeetingTask.objects.create(meeting=meeting, task=task)
    item["task_key"] = task.key
    meeting.save(update_fields=["action_items", "updated_at"])

    record_transition(
        task,
        from_column=None,
        to_column=column,
        event_type=TransitionEvent.CREATED,
        user=user,
        source=source,
    )
    broadcast_task_event(proj.id, "task.created", {"key": task.key, "id": task.id})
    notify_task_event(task, user, "created", recipients=[])
    return task


# ---------------------------------------------------------------------------
# Upsert (pipeline) and curation (people)
# ---------------------------------------------------------------------------


def _is_empty(meeting: Meeting, field: str) -> bool:
    # "other" is the category default, i.e. nobody has categorised it yet.
    return getattr(meeting, field) in (None, "", MeetingCategory.OTHER)


@transaction.atomic
def upsert_meeting(data: dict[str, Any], *, user=None) -> tuple[Meeting, bool]:
    """Create or refresh the meeting identified by ``data["stem"]``.

    ``data`` is ``MeetingUpsertSerializer.validated_data``. Returns
    ``(meeting, created)``.
    """
    if data.get("route", MeetingRoute.WORK) != MeetingRoute.WORK:
        # Task Manager is shared; personal recordings don't belong here.
        raise MeetingError("Only work recordings can be stored in Task Manager.")

    overwrite = bool(data.get("overwrite_metadata"))
    if "project" in data:
        data = {**data, "project": resolve_project(data["project"])}

    # Two parallel *first* pushes of one stem both see nothing here; SQLite
    # serializes writers so it can't happen today, but on Postgres the loser
    # would hit the unique constraint — retry on IntegrityError after the swap.
    meeting = Meeting.objects.select_for_update().filter(stem=data["stem"]).first()
    created = meeting is None
    if created:
        if not data.get("title") or not data.get("started_at"):
            raise MeetingError("title and started_at are required for a new meeting.")
        meeting = Meeting(
            stem=data["stem"],
            created_by=user if getattr(user, "is_authenticated", False) else None,
        )

    for field in PIPELINE_FIELDS:
        if field in data:
            setattr(meeting, field, data[field])
    for field in CURATED_FIELDS:
        if field in data and (created or overwrite or _is_empty(meeting, field)):
            setattr(meeting, field, data[field])
    if "action_items" in data:
        meeting.action_items = merge_action_items(
            meeting.action_items or [], data["action_items"]
        )
    meeting.save()

    if "entities" in data:
        _link_entities(meeting, data["entities"], replace=False)
    if "tags" in data:
        _set_tags(meeting, data["tags"], replace=created or overwrite)
    return meeting, created


@transaction.atomic
def curate_meeting(meeting: Meeting, data: dict[str, Any]) -> Meeting:
    """Apply a person's edits. Unlike upsert, entity and tag lists are exact."""
    for field in ("title", "category", "started_at", "summary", "gshr_url"):
        if field in data:
            setattr(meeting, field, data[field])
    if "project" in data:
        meeting.project = resolve_project(data["project"])
    meeting.save()
    if "entities" in data:
        _link_entities(meeting, data["entities"], replace=True)
    if "tags" in data:
        _set_tags(meeting, data["tags"], replace=True)
    return meeting
