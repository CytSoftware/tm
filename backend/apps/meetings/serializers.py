from __future__ import annotations

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers

from .models import (
    Entity,
    EntityKind,
    EntityRole,
    Meeting,
    MeetingCategory,
    MeetingLinkKind,
    MeetingRoute,
)
from .query import search_snippet


class AwareDateTimeField(serializers.DateTimeField):
    """Refuse timestamps without an offset.

    Recording stems are naive local time. DRF would silently stamp a naive
    value with the server's timezone (UTC), shifting every meeting by the
    recorder's offset and putting late-evening meetings on the wrong day.
    """

    def to_internal_value(self, value):
        if isinstance(value, str):
            parsed = parse_datetime(value)
            if parsed is not None and timezone.is_naive(parsed):
                raise serializers.ValidationError(
                    "Timestamp must include a UTC offset, "
                    "e.g. 2026-09-16T15:50:09+03:00."
                )
        return super().to_internal_value(value)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


class EntitySerializer(serializers.ModelSerializer):
    meeting_count = serializers.IntegerField(read_only=True, required=False)
    company_name = serializers.CharField(source="company.name", read_only=True)

    class Meta:
        model = Entity
        fields = [
            "id",
            "kind",
            "name",
            "slug",
            "aliases",
            "wiki_slug",
            "company",
            "company_name",
            "meeting_count",
        ]
        read_only_fields = ["id", "kind", "slug"]

    def validate_company(self, company):
        if company is not None and company.kind != EntityKind.COMPANY:
            raise serializers.ValidationError("Must be a company.")
        return company

    def validate(self, attrs):
        if attrs.get("company") and self.instance.kind != EntityKind.PERSON:
            raise serializers.ValidationError(
                {"company": "Only a person can belong to a company."}
            )
        return attrs


def _entity_links(meeting: Meeting) -> list[dict]:
    return [
        {
            "id": link.entity_id,
            "kind": link.entity.kind,
            "name": link.entity.name,
            "slug": link.entity.slug,
            "role": link.role,
            "company_id": link.entity.company_id,
        }
        for link in meeting.entity_links.all()  # prefetched, ordered
    ]


class MeetingListSerializer(serializers.ModelSerializer):
    """Light shape for lists, the timeline and search — no transcript/brief."""

    project = serializers.SerializerMethodField()
    entities = serializers.SerializerMethodField()
    tags = serializers.SerializerMethodField()
    action_item_count = serializers.SerializerMethodField()
    open_action_item_count = serializers.SerializerMethodField()
    snippet = serializers.SerializerMethodField()

    class Meta:
        model = Meeting
        fields = [
            "key",
            "stem",
            "title",
            "started_at",
            "duration_seconds",
            "language",
            "speaker_count",
            "category",
            "summary",
            "gshr_url",
            "project",
            "entities",
            "tags",
            "action_item_count",
            "open_action_item_count",
            "snippet",
            "created_at",
            "updated_at",
        ]

    def get_project(self, obj):
        p = obj.project
        if p is None:
            return None
        return {"id": p.id, "prefix": p.prefix, "name": p.name, "color": p.color}

    def get_entities(self, obj):
        return _entity_links(obj)

    def get_tags(self, obj):
        return [t.name for t in obj.tags.all()]

    def get_action_item_count(self, obj):
        return len(obj.action_items or [])

    def get_open_action_item_count(self, obj):
        return sum(1 for i in obj.action_items or [] if not i.get("done"))

    def get_snippet(self, obj):
        return search_snippet(obj, self.context.get("search") or "")


class MeetingDetailSerializer(MeetingListSerializer):
    linked_tasks = serializers.SerializerMethodField()
    has_brief_html = serializers.SerializerMethodField()

    class Meta(MeetingListSerializer.Meta):
        # brief_html is stored but never sent to the browser: the app doesn't
        # render raw HTML, and the styled version lives at gshr_url.
        fields = MeetingListSerializer.Meta.fields + [
            "brief_md",
            "transcript_md",
            "action_items",
            "linked_tasks",
            "has_brief_html",
            "source_meta",
        ]

    def get_linked_tasks(self, obj):
        links = obj.task_links.select_related("task__column", "task__project")
        return [
            {
                "key": link.task.key,
                "title": link.task.title,
                "column": link.task.column.name if link.task.column else None,
                "is_done": bool(link.task.column and link.task.column.is_done),
                "project": link.task.project.prefix if link.task.project else None,
            }
            for link in links
        ]

    def get_has_brief_html(self, obj):
        return bool(obj.brief_html)


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


class EntitySpecSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=EntityKind.choices)
    name = serializers.CharField(max_length=200)
    role = serializers.ChoiceField(
        choices=EntityRole.choices, default=EntityRole.ATTENDEE
    )
    company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, allow_null=True
    )


class ActionItemInputSerializer(serializers.Serializer):
    id = serializers.CharField(max_length=64, required=False, allow_blank=True)
    text = serializers.CharField()
    owner = serializers.CharField(required=False, allow_blank=True, default="")
    done = serializers.BooleanField(required=False, default=False)


class MeetingUpsertSerializer(serializers.Serializer):
    """The ingest payload. Shared by ``POST /api/meetings/`` and the MCP tool,
    so both validate identically before ``services.upsert_meeting``."""

    stem = serializers.CharField(max_length=128)
    title = serializers.CharField(max_length=300, required=False)
    started_at = AwareDateTimeField(required=False)
    duration_seconds = serializers.IntegerField(
        min_value=0, required=False, allow_null=True
    )
    language = serializers.CharField(max_length=32, required=False, allow_blank=True)
    speaker_count = serializers.IntegerField(
        min_value=0, max_value=32767, required=False, allow_null=True
    )
    route = serializers.ChoiceField(choices=MeetingRoute.choices, required=False)
    category = serializers.ChoiceField(
        choices=MeetingCategory.choices, required=False
    )
    summary = serializers.CharField(required=False, allow_blank=True)
    brief_md = serializers.CharField(required=False, allow_blank=True)
    brief_html = serializers.CharField(required=False, allow_blank=True)
    transcript_md = serializers.CharField(required=False, allow_blank=True)
    gshr_url = serializers.URLField(max_length=500, required=False, allow_blank=True)
    project = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    entities = EntitySpecSerializer(many=True, required=False)
    tags = serializers.ListField(
        child=serializers.CharField(max_length=64), required=False
    )
    action_items = ActionItemInputSerializer(many=True, required=False)
    source_meta = serializers.DictField(required=False)
    overwrite_metadata = serializers.BooleanField(required=False, default=False)


class MeetingCurateSerializer(serializers.Serializer):
    """What a person can edit from the UI (``PATCH``)."""

    title = serializers.CharField(max_length=300, required=False)
    started_at = AwareDateTimeField(required=False)
    category = serializers.ChoiceField(
        choices=MeetingCategory.choices, required=False
    )
    summary = serializers.CharField(required=False, allow_blank=True)
    gshr_url = serializers.URLField(max_length=500, required=False, allow_blank=True)
    project = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    entities = EntitySpecSerializer(many=True, required=False)
    tags = serializers.ListField(
        child=serializers.CharField(max_length=64), required=False
    )


class MeetingLinkInputSerializer(serializers.Serializer):
    to = serializers.CharField(help_text="Key of the meeting to link to.")
    kind = serializers.ChoiceField(
        choices=MeetingLinkKind.choices, default=MeetingLinkKind.RELATED
    )
    note = serializers.CharField(
        max_length=300, required=False, allow_blank=True, default=""
    )
