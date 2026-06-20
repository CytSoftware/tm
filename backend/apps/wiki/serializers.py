"""DRF serializers for the wiki app."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.tasks.models import Project

from .models import Doc

User = get_user_model()


class _UserSlim(serializers.ModelSerializer):
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "username", "email", "first_name", "last_name", "avatar_url")

    def get_avatar_url(self, obj) -> str:
        profile = getattr(obj, "profile", None)
        if not profile:
            return ""
        raw = profile.effective_avatar_url
        if not raw:
            return ""
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        request = self.context.get("request")
        if request is not None:
            return request.build_absolute_uri(raw)
        return raw


class DocReadSerializer(serializers.ModelSerializer):
    """Lightweight tree node — no body content or CRDT state."""

    created_by = _UserSlim(read_only=True)
    last_edited_by = _UserSlim(read_only=True)
    has_children = serializers.BooleanField(read_only=True)

    class Meta:
        model = Doc
        fields = (
            "id",
            "key",
            "title",
            "parent",
            "position",
            "project",
            "created_by",
            "last_edited_by",
            "has_children",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class DocDetailSerializer(DocReadSerializer):
    """Detail view also returns the denormalized body snapshot."""

    class Meta(DocReadSerializer.Meta):
        fields = DocReadSerializer.Meta.fields + ("content",)
        read_only_fields = fields


class DocWriteSerializer(serializers.ModelSerializer):
    """Create / update page metadata only — never the body (that is CRDT-owned)."""

    parent_id = serializers.PrimaryKeyRelatedField(
        queryset=Doc.objects.all(),
        source="parent",
        required=False,
        allow_null=True,
    )
    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(),
        source="project",
        required=False,
        allow_null=True,
    )

    class Meta:
        model = Doc
        fields = ("id", "key", "title", "parent_id", "project_id")
        read_only_fields = ("id", "key")

    def create(self, validated_data):
        user = self._request_user()
        if user is not None:
            validated_data.setdefault("created_by", user)
            validated_data.setdefault("last_edited_by", user)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        user = self._request_user()
        if user is not None:
            validated_data["last_edited_by"] = user
        return super().update(instance, validated_data)

    def _request_user(self):
        request = self.context.get("request")
        user = getattr(request, "user", None) if request else None
        if user is not None and user.is_authenticated:
            return user
        return None


class DocMoveSerializer(serializers.Serializer):
    """Reparent + reorder. ``parent_id`` omitted = keep current parent."""

    parent_id = serializers.IntegerField(required=False, allow_null=True)
    position = serializers.FloatField(required=False)
    before_id = serializers.IntegerField(required=False, allow_null=True)
    after_id = serializers.IntegerField(required=False, allow_null=True)


class DocSnapshotSerializer(serializers.Serializer):
    """Client-pushed denormalized body snapshot (the Plate value)."""

    content = serializers.JSONField()
