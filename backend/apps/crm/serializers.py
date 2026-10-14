from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.meetings.models import Entity, EntityKind, Meeting
from apps.meetings.serializers import AwareDateTimeField
from apps.tasks.models import Project, Task
from apps.tasks.serializers import UserSerializer

from .models import Lead, LeadStage, Update, UpdateKind
from .query import CLOSED_COLUMN_KINDS

User = get_user_model()


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def entity_ref(entity: Entity | None) -> dict | None:
    if entity is None:
        return None
    # website rides along so any company reference can show its logo.
    return {
        "id": entity.id,
        "kind": entity.kind,
        "name": entity.name,
        "position": entity.position,
        "website": entity.website,
    }


def project_ref(p) -> dict | None:
    if p is None:
        return None
    return {"id": p.id, "prefix": p.prefix, "name": p.name, "color": p.color}


def _users(users, context) -> list:
    # `or {}`: the MCP tools call this without a request, and DRF keeps an
    # explicit None as the context — an uploaded avatar then crashed on
    # `self.context.get("request")`.
    return UserSerializer(users, many=True, context=context or {}).data


def step_dict(task: Task, *, context=None) -> dict:
    return {
        "key": task.key,
        "title": task.title,
        "due_at": task.due_at,
        "is_open": (task.column.kind if task.column_id else None) not in CLOSED_COLUMN_KINDS,
        "assignees": _users(task.assignees.all(), context),
    }


def update_dict(u: Update, *, context=None) -> dict:
    lead = u.lead
    meeting = u.meeting
    return {
        "id": u.id,
        "kind": u.kind,
        "body": u.body,
        "task": step_dict(u.task, context=context) if u.task_id else None,
        "occurred_at": u.occurred_at,
        "lead": (
            {"key": lead.key, "title": lead.title, "company": entity_ref(lead.company)}
            if lead
            else None
        ),
        "people": [
            {**entity_ref(p), "company": p.company.name if p.company_id else None}
            for p in u.people.all()
        ],
        "users": _users(u.users.all(), context),
        "meeting": (
            {
                "key": meeting.key,
                "title": meeting.title,
                "gshr_url": meeting.gshr_url,
                "duration_seconds": meeting.duration_seconds,
            }
            if meeting
            else None
        ),
        "created_by": _users([u.created_by], context)[0] if u.created_by_id else None,
        "created_at": u.created_at,
    }


class ContactSerializer(serializers.ModelSerializer):
    """List shape. Expects a queryset from ``query.base_contact_queryset``
    (the derived fields are annotations)."""

    company = serializers.SerializerMethodField()
    emails = serializers.SerializerMethodField()
    last_update = serializers.SerializerMethodField()
    people_count = serializers.IntegerField(read_only=True)
    open_lead_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Entity
        fields = [
            "id",
            "kind",
            "name",
            "slug",
            "aliases",
            "position",
            "company",
            "emails",
            "phone",
            "linkedin_url",
            "website",
            "wiki_slug",
            "last_update",
            "people_count",
            "open_lead_count",
            "created_at",
        ]

    def get_company(self, obj):
        return entity_ref(obj.company)

    def get_emails(self, obj):
        return [e.email for e in obj.emails.all()]

    def get_last_update(self, obj):
        at = getattr(obj, "last_update_at", None)
        if at is None:
            return None
        return {
            "at": serializers.DateTimeField().to_representation(at),
            "kind": obj.last_update_kind,
            "body": obj.last_update_body,
        }


class LeadSerializer(serializers.ModelSerializer):
    """Expects a queryset from ``query.base_lead_queryset``."""

    company = serializers.SerializerMethodField()
    project = serializers.SerializerMethodField()
    next_step = serializers.SerializerMethodField()
    last_update_at = serializers.DateTimeField(read_only=True)

    class Meta:
        model = Lead
        fields = [
            "key",
            "title",
            "stage",
            "company",
            "project",
            "notes",
            "lost_reason",
            "position",
            "closed_at",
            "next_step",
            "last_update_at",
            "created_at",
            "updated_at",
        ]

    def get_company(self, obj):
        return entity_ref(obj.company)

    def get_project(self, obj):
        return project_ref(obj.project)

    def get_next_step(self, obj):
        key = getattr(obj, "next_step_key", None)
        if not key:
            return None
        due = obj.next_step_due
        return {
            "key": key,
            "title": obj.next_step_title,
            "due_at": serializers.DateTimeField().to_representation(due) if due else None,
        }


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


class BareUrlField(serializers.URLField):
    """A URL that may be typed without a scheme ("acme.com" → https://acme.com)."""

    def to_internal_value(self, data):
        if isinstance(data, str):
            data = data.strip()
            if data and "://" not in data:
                data = f"https://{data}"
        return super().to_internal_value(data)


class ContactWriteSerializer(serializers.Serializer):
    """Create (``POST``) and edit (``PATCH``, ``partial=True``) a contact."""

    kind = serializers.ChoiceField(choices=EntityKind.choices, required=False)
    name = serializers.CharField(max_length=200)
    position = serializers.CharField(max_length=200, required=False, allow_blank=True)
    company = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    emails = serializers.ListField(child=serializers.EmailField(), required=False)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    linkedin_url = BareUrlField(max_length=300, required=False, allow_blank=True)
    website = BareUrlField(max_length=300, required=False, allow_blank=True)
    wiki_slug = serializers.CharField(max_length=255, required=False, allow_blank=True)


class LeadWriteSerializer(serializers.Serializer):
    """Create (``POST``) and edit (``PATCH``, ``partial=True``) a lead."""

    title = serializers.CharField(max_length=200)
    stage = serializers.ChoiceField(choices=LeadStage.choices, required=False)
    company = serializers.PrimaryKeyRelatedField(
        queryset=Entity.objects.filter(kind=EntityKind.COMPANY),
        required=False,
        allow_null=True,
    )
    project = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), required=False, allow_null=True
    )
    notes = serializers.CharField(required=False, allow_blank=True)
    lost_reason = serializers.CharField(max_length=300, required=False, allow_blank=True)


class UpdateInputSerializer(serializers.Serializer):
    """Post (``POST``) or correct (``PATCH``, ``partial=True``) an update."""

    kind = serializers.ChoiceField(choices=UpdateKind.choices, required=False)
    body = serializers.CharField()
    occurred_at = AwareDateTimeField(required=False)
    lead = serializers.SlugRelatedField(
        slug_field="key", queryset=Lead.objects.all(), required=False, allow_null=True
    )
    people = serializers.PrimaryKeyRelatedField(
        queryset=Entity.objects.all(), many=True, required=False
    )
    users = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), many=True, required=False
    )
    meeting = serializers.SlugRelatedField(
        slug_field="key", queryset=Meeting.objects.all(), required=False, allow_null=True
    )
    # What they need next — filed as a task on create, ignored on edit.
    next_step = serializers.CharField(max_length=300, required=False, allow_blank=True)
    next_due = serializers.DateField(required=False, allow_null=True)
    next_assignee = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), required=False, allow_null=True
    )
    tz = serializers.CharField(required=False, allow_blank=True)
