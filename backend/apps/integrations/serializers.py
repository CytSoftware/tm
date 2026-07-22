"""DRF serializers for integrations models.

``LinkedPRSerializer`` is the read shape the tasks app splices into
``TaskReadSerializer`` via a lazy import. Kept here so the GitHub-specific
field list lives next to the model.
"""

from __future__ import annotations

from django.urls import reverse
from rest_framework import serializers

from .models import EventSource, ExternalEvent, ProjectRepository, TaskPullRequest


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
            "active",
            "webhook_url",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "webhook_url", "created_at", "updated_at")

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
