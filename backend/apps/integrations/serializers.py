"""DRF serializers for integrations models.

``LinkedPRSerializer`` is the read shape the tasks app splices into
``TaskReadSerializer`` via a lazy import. Kept here so the GitHub-specific
field list lives next to the model.
"""

from __future__ import annotations

from django.urls import reverse
from rest_framework import serializers

from .models import (
    EventSource,
    ExternalEvent,
    InfrastructureService,
    ProjectRepository,
    TaskPullRequest,
)


class ProjectRepositoryNestedSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProjectRepository
        fields = ("id", "repo_id", "repo_full_name", "default_branch")
        read_only_fields = fields


class LinkedPRSerializer(serializers.ModelSerializer):
    repository = ProjectRepositoryNestedSerializer(read_only=True)

    class Meta:
        model = TaskPullRequest
        fields = (
            "id",
            "pr_number",
            "pr_title",
            "state",
            "merged",
            "is_draft",
            "head_ref",
            "base_ref",
            "html_url",
            "author_login",
            "reviewer_login",
            "repository",
            "opened_at",
            "merged_at",
            "closed_at",
            "updated_at",
        )
        read_only_fields = fields


class EventSourceSerializer(serializers.ModelSerializer):
    webhook_url = serializers.SerializerMethodField()

    class Meta:
        model = EventSource
        fields = (
            "id",
            "name",
            "provider",
            "icon",
            "columns",
            "active",
            "webhook_url",
            "created_by",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "webhook_url",
            "created_by",
            "created_at",
            "updated_at",
        )

    def validate_columns(self, value: list) -> list:
        if not isinstance(value, list):
            raise serializers.ValidationError("Columns must be a list.")
        if len(value) > 100:
            raise serializers.ValidationError("At most 100 columns are allowed.")
        cleaned: list[dict] = []
        seen: set[str] = set()
        for column in value:
            if not isinstance(column, dict):
                raise serializers.ValidationError("Every column must be an object.")
            column_id = column.get("id")
            label = column.get("label")
            visible = column.get("visible")
            if not isinstance(column_id, str) or not column_id or len(column_id) > 255:
                raise serializers.ValidationError("Every column needs a valid id.")
            if column_id in seen:
                raise serializers.ValidationError(f"Duplicate column id: {column_id}")
            if not isinstance(label, str) or not label.strip() or len(label) > 100:
                raise serializers.ValidationError("Every column needs a valid label.")
            if not isinstance(visible, bool):
                raise serializers.ValidationError("Column visibility must be true or false.")
            seen.add(column_id)
            cleaned.append(
                {"id": column_id, "label": label.strip(), "visible": visible}
            )
        return cleaned

    def get_webhook_url(self, obj: EventSource) -> str:
        path = reverse("event-source-ingest", kwargs={"token": obj.token})
        request = self.context.get("request")
        return request.build_absolute_uri(path) if request else path


class ExternalEventSerializer(serializers.ModelSerializer):
    source_name = serializers.CharField(source="source.name", read_only=True)
    provider = serializers.CharField(source="source.provider", read_only=True)

    class Meta:
        model = ExternalEvent
        fields = (
            "id",
            "source",
            "source_name",
            "provider",
            "external_id",
            "event_type",
            "title",
            "severity",
            "provider_status",
            "workflow_status",
            "target_url",
            "occurred_at",
            "payload",
            "occurrence_count",
            "received_at",
            "last_received_at",
        )
        read_only_fields = (
            "id",
            "source",
            "source_name",
            "provider",
            "external_id",
            "event_type",
            "title",
            "severity",
            "provider_status",
            "target_url",
            "occurred_at",
            "payload",
            "occurrence_count",
            "received_at",
            "last_received_at",
        )


class InfrastructureServiceSerializer(serializers.ModelSerializer):
    logo = serializers.ImageField(write_only=True, required=False, allow_null=True)
    logo_url = serializers.SerializerMethodField()
    remove_logo = serializers.BooleanField(
        write_only=True, required=False, default=False
    )

    class Meta:
        model = InfrastructureService
        fields = (
            "id",
            "name",
            "url",
            "category",
            "description",
            "logo",
            "logo_url",
            "remove_logo",
            "position",
            "created_by",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "logo_url",
            "position",
            "created_by",
            "created_at",
            "updated_at",
        )

    def validate_logo(self, value):
        if value is None:
            return value
        if value.size > 2 * 1024 * 1024:
            raise serializers.ValidationError("Logo must be 2 MB or smaller.")
        content_type = (getattr(value, "content_type", "") or "").lower()
        if content_type and not content_type.startswith("image/"):
            raise serializers.ValidationError("Logo must be an image.")
        return value

    def validate(self, attrs):
        if attrs.get("remove_logo") and attrs.get("logo") is not None:
            raise serializers.ValidationError(
                {"logo": "Upload a logo or remove the current one, not both."}
            )
        return attrs

    def create(self, validated_data):
        validated_data.pop("remove_logo", None)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        remove_logo = validated_data.pop("remove_logo", False)
        replacing_logo = "logo" in validated_data
        old_name = instance.logo.name if instance.logo else ""
        old_storage = instance.logo.storage if instance.logo else None

        updated = super().update(instance, validated_data)
        if remove_logo:
            updated.logo = None
            updated.save(update_fields=["logo", "updated_at"])
        if old_name and (remove_logo or replacing_logo):
            new_name = updated.logo.name if updated.logo else ""
            if old_name != new_name and old_storage is not None:
                old_storage.delete(old_name)
        return updated

    def get_logo_url(self, obj: InfrastructureService) -> str:
        if not obj.logo:
            return ""
        try:
            path = obj.logo.url
        except ValueError:
            return ""
        request = self.context.get("request")
        return request.build_absolute_uri(path) if request else path
