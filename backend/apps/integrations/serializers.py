"""DRF serializers for integrations models.

``LinkedPRSerializer`` is the read shape the tasks app splices into
``TaskReadSerializer`` via a lazy import. Kept here so the GitHub-specific
field list lives next to the model.
"""

from __future__ import annotations

from rest_framework import serializers

from .models import ProjectRepository, TaskPullRequest


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
