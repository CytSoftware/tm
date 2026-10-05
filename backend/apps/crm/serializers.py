from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.meetings.models import Entity, EntityKind, RelationshipType
from apps.meetings.serializers import AwareDateTimeField
from apps.tasks.models import Project
from apps.tasks.serializers import UserSerializer

from .models import (
    Deal,
    FollowUp,
    Pipeline,
    Stage,
    StageKind,
    Touchpoint,
    TouchpointDirection,
    TouchpointKind,
    TouchpointSource,
)
from .query import CLOSED_COLUMN_KINDS, last_activity, real_date

User = get_user_model()


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def entity_ref(entity: Entity | None) -> dict | None:
    if entity is None:
        return None
    # website rides along so any company reference can show its logo.
    return {"id": entity.id, "kind": entity.kind, "name": entity.name, "website": entity.website}


def follow_up_dict(f: FollowUp, *, context=None) -> dict:
    task = f.task
    kind = task.column.kind if task.column_id else None
    return {
        "id": f.id,
        "task_key": task.key,
        "title": task.title,
        "description": task.description,
        "due_at": task.due_at,
        "column": task.column.name if task.column_id else None,
        "is_open": kind not in CLOSED_COLUMN_KINDS,
        "assignees": UserSerializer(task.assignees.all(), many=True, context=context).data,
        "entity": entity_ref(f.entity),
        "company": entity_ref(f.entity.company) if f.entity.company_id else None,
        "deal": {"key": f.deal.key, "title": f.deal.title} if f.deal_id else None,
        "created_at": f.created_at,
    }


class ContactSerializer(serializers.ModelSerializer):
    """List shape. Expects a queryset from ``query.base_contact_queryset``
    (the derived dates are annotations)."""

    owner = UserSerializer(read_only=True)
    company = serializers.SerializerMethodField()
    emails = serializers.SerializerMethodField()
    last_contact_at = serializers.SerializerMethodField()
    last_activity = serializers.SerializerMethodField()
    next_follow_up_at = serializers.DateTimeField(read_only=True)
    next_follow_up_title = serializers.CharField(read_only=True)
    has_open_follow_up = serializers.BooleanField(read_only=True)
    people_count = serializers.IntegerField(read_only=True)
    open_deal_count = serializers.IntegerField(read_only=True)
    open_deal_value = serializers.DecimalField(
        max_digits=16, decimal_places=2, read_only=True, allow_null=True
    )

    class Meta:
        model = Entity
        fields = [
            "id",
            "kind",
            "name",
            "slug",
            "aliases",
            "relationship",
            "owner",
            "headline",
            "company",
            "emails",
            "phone",
            "whatsapp",
            "linkedin_url",
            "website",
            "wiki_slug",
            "last_contact_at",
            "last_activity",
            "next_follow_up_at",
            "next_follow_up_title",
            "has_open_follow_up",
            "people_count",
            "open_deal_count",
            "open_deal_value",
            "created_at",
        ]

    def get_company(self, obj):
        return entity_ref(obj.company)

    def get_emails(self, obj):
        return [e.email for e in obj.emails.all()]

    def get_last_activity(self, obj):
        item = last_activity(obj)
        if item is None:
            return None
        return {**item, "at": serializers.DateTimeField().to_representation(item["at"])}

    def get_last_contact_at(self, obj):
        value = real_date(getattr(obj, "last_contact_at", None))
        return serializers.DateTimeField().to_representation(value) if value else None


class BareUrlField(serializers.URLField):
    """A URL that may be typed without a scheme ("acme.com" → https://acme.com)."""

    def to_internal_value(self, data):
        if isinstance(data, str):
            data = data.strip()
            if data and "://" not in data:
                data = f"https://{data}"
        return super().to_internal_value(data)


class ContactWriteSerializer(serializers.Serializer):
    """Create (``POST``) and edit (``PATCH``) a contact."""

    kind = serializers.ChoiceField(choices=EntityKind.choices, required=False)
    name = serializers.CharField(max_length=200, required=False)
    relationship = serializers.ChoiceField(
        choices=[("", "Not in CRM"), *RelationshipType.choices], required=False
    )
    owner = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), required=False, allow_null=True
    )
    headline = serializers.CharField(max_length=200, required=False, allow_blank=True)
    company = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    emails = serializers.ListField(
        child=serializers.EmailField(), required=False
    )
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    whatsapp = serializers.CharField(max_length=40, required=False, allow_blank=True)
    linkedin_url = BareUrlField(max_length=300, required=False, allow_blank=True)
    website = BareUrlField(max_length=300, required=False, allow_blank=True)
    wiki_slug = serializers.CharField(max_length=255, required=False, allow_blank=True)


class StageSerializer(serializers.ModelSerializer):
    deal_count = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Stage
        fields = ["id", "name", "kind", "position", "deal_count"]


class PipelineSerializer(serializers.ModelSerializer):
    stages = serializers.SerializerMethodField()

    class Meta:
        model = Pipeline
        fields = ["id", "name", "slug", "position", "stages"]

    def get_stages(self, obj):
        counts = self.context.get("stage_counts") or {}
        return [
            {**StageSerializer(s).data, "deal_count": counts.get(s.id, 0)}
            for s in obj.stages.all()
        ]


class DealSerializer(serializers.ModelSerializer):
    owner = UserSerializer(read_only=True)
    company = serializers.SerializerMethodField()
    contacts = serializers.SerializerMethodField()
    stage = serializers.SerializerMethodField()
    pipeline = serializers.SerializerMethodField()
    product_project = serializers.SerializerMethodField()

    class Meta:
        model = Deal
        fields = [
            "key",
            "title",
            "pipeline",
            "stage",
            "company",
            "contacts",
            "owner",
            "value",
            "currency",
            "product_project",
            "expected_close",
            "notes",
            "position",
            "closed_at",
            "lost_reason",
            "created_at",
            "updated_at",
        ]

    def get_company(self, obj):
        return entity_ref(obj.company)

    def get_contacts(self, obj):
        return [entity_ref(c) for c in obj.contacts.all()]

    def get_stage(self, obj):
        s = obj.stage
        return {"id": s.id, "name": s.name, "kind": s.kind}

    def get_pipeline(self, obj):
        p = obj.pipeline
        return {"id": p.id, "name": p.name, "slug": p.slug}

    def get_product_project(self, obj):
        p = obj.product_project
        if p is None:
            return None
        return {"id": p.id, "prefix": p.prefix, "name": p.name, "color": p.color}


class TouchpointSerializer(serializers.ModelSerializer):
    entities = serializers.SerializerMethodField()
    deal = serializers.SerializerMethodField()

    class Meta:
        model = Touchpoint
        fields = [
            "id",
            "kind",
            "direction",
            "occurred_at",
            "summary",
            "entities",
            "deal",
            "source",
            "external_id",
            "created_at",
        ]

    def get_entities(self, obj):
        return [entity_ref(e) for e in obj.entities.all()]

    def get_deal(self, obj):
        return obj.deal.key if obj.deal_id else None


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


class FollowUpSpecSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=300)
    due = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    assignee = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), required=False, allow_null=True
    )


class TouchpointInputSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=TouchpointKind.choices)
    direction = serializers.ChoiceField(
        choices=TouchpointDirection.choices, required=False, allow_blank=True
    )
    occurred_at = AwareDateTimeField(required=False)
    summary = serializers.CharField()
    entities = serializers.PrimaryKeyRelatedField(
        queryset=Entity.objects.all(), many=True
    )
    deal = serializers.SlugRelatedField(
        slug_field="key", queryset=Deal.objects.all(), required=False, allow_null=True
    )
    source = serializers.ChoiceField(
        choices=TouchpointSource.choices, required=False
    )
    external_id = serializers.CharField(max_length=255, required=False, allow_blank=True)
    follow_up = FollowUpSpecSerializer(required=False, allow_null=True)
    tz = serializers.CharField(required=False, allow_blank=True)


class TouchpointPatchSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=TouchpointKind.choices, required=False)
    direction = serializers.ChoiceField(
        choices=TouchpointDirection.choices, required=False, allow_blank=True
    )
    occurred_at = AwareDateTimeField(required=False)
    summary = serializers.CharField(required=False)
    entities = serializers.PrimaryKeyRelatedField(
        queryset=Entity.objects.all(), many=True, required=False
    )
    deal = serializers.SlugRelatedField(
        slug_field="key", queryset=Deal.objects.all(), required=False, allow_null=True
    )


class FollowUpInputSerializer(serializers.Serializer):
    entity = serializers.PrimaryKeyRelatedField(queryset=Entity.objects.all())
    title = serializers.CharField(max_length=300)
    due = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    deal = serializers.SlugRelatedField(
        slug_field="key", queryset=Deal.objects.all(), required=False, allow_null=True
    )
    assignee = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), required=False, allow_null=True
    )
    description = serializers.CharField(required=False, allow_blank=True)
    tz = serializers.CharField(required=False, allow_blank=True)


class DealWriteSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False)
    pipeline = serializers.PrimaryKeyRelatedField(
        queryset=Pipeline.objects.all(), required=False
    )
    stage = serializers.PrimaryKeyRelatedField(
        queryset=Stage.objects.all(), required=False
    )
    company = serializers.PrimaryKeyRelatedField(
        queryset=Entity.objects.filter(kind=EntityKind.COMPANY),
        required=False,
        allow_null=True,
    )
    contacts = serializers.PrimaryKeyRelatedField(
        queryset=Entity.objects.all(), many=True, required=False
    )
    owner = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), required=False, allow_null=True
    )
    value = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, allow_null=True
    )
    currency = serializers.CharField(max_length=3, required=False)
    product_project = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), required=False, allow_null=True
    )
    expected_close = serializers.DateField(required=False, allow_null=True)
    notes = serializers.CharField(required=False, allow_blank=True)
    lost_reason = serializers.CharField(max_length=300, required=False, allow_blank=True)


class StageSpecSerializer(serializers.Serializer):
    id = serializers.IntegerField(required=False, allow_null=True)
    name = serializers.CharField(max_length=80)
    kind = serializers.ChoiceField(choices=StageKind.choices, default=StageKind.OPEN)
