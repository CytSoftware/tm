"""Admin registration for integrations models.

P0 exposes ``ProjectRepository`` and ``TaskPullRequest`` through the admin
so Chris can hand-create a repo link for the manual-webhook smoke test —
that's the intended P0 workflow before the P0.5 click-to-connect flow lands.
"""

from django.contrib import admin

from .models import GitHubInstallation, ProjectRepository, TaskPullRequest


@admin.register(GitHubInstallation)
class GitHubInstallationAdmin(admin.ModelAdmin):
    list_display = (
        "account_login",
        "installation_id",
        "account_type",
        "suspended_at",
        "created_at",
    )
    search_fields = ("account_login", "installation_id")


@admin.register(ProjectRepository)
class ProjectRepositoryAdmin(admin.ModelAdmin):
    list_display = (
        "project",
        "repo_full_name",
        "repo_id",
        "default_branch",
        "installation",
        "created_at",
    )
    list_filter = ("project",)
    search_fields = (
        "repo_full_name",
        "project__prefix",
        "project__name",
    )
    autocomplete_fields = ("project", "installation")


@admin.register(TaskPullRequest)
class TaskPullRequestAdmin(admin.ModelAdmin):
    list_display = (
        "task",
        "repository",
        "pr_number",
        "state",
        "merged",
        "is_draft",
        "updated_at",
    )
    list_filter = ("state", "merged", "is_draft", "repository")
    search_fields = ("task__key", "pr_title", "author_login")
    autocomplete_fields = ("task", "repository")
    readonly_fields = ("updated_at",)
