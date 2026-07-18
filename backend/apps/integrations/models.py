"""Third-party integration models.

Currently hosts GitHub App installation, project↔repository links, and
task↔pull-request associations. The P0 slice (manual webhook, link-only)
uses ``ProjectRepository`` and ``TaskPullRequest``; ``GitHubInstallation``
stays empty until the P0.5 click-to-connect flow ships.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class GitHubInstallation(models.Model):
    """One row per GitHub App install.

    In P0 this table may be empty — ``ProjectRepository`` rows can be created
    via the Django admin without an installation. P0.5 populates it via the
    one-click install flow.
    """

    installation_id = models.BigIntegerField(unique=True)
    account_login = models.CharField(max_length=200)
    account_type = models.CharField(
        max_length=20,
        default="Organization",
        help_text='"Organization" or "User" — echoed from GitHub.',
    )
    installed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="github_installations",
    )
    suspended_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.account_login} ({self.installation_id})"


class ProjectRepository(models.Model):
    """Links a Project to a GitHub repository.

    ``repo_id`` is the numeric GitHub id — stable across renames, so renaming
    ``owner/repo`` does not break the link. ``repo_full_name`` is a display
    cache refreshed on every webhook.

    The uniqueness constraint is ``(project, repo_id)``, NOT ``repo_id`` alone,
    so two projects can legitimately point at the same repository. The webhook
    handler MUST iterate every matching row.
    """

    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.CASCADE,
        related_name="repositories",
    )
    installation = models.ForeignKey(
        GitHubInstallation,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="project_repositories",
    )
    repo_id = models.BigIntegerField()
    repo_full_name = models.CharField(max_length=300)
    default_branch = models.CharField(max_length=200, default="main")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "repo_id"],
                name="uniq_project_repo",
            ),
        ]
        indexes = [
            models.Index(fields=["repo_id"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.project.prefix} ↔ {self.repo_full_name}"


class TaskPullRequest(models.Model):
    """Association between a Task and a specific GitHub PR.

    Updated on every PR webhook event so cached display fields stay current.
    Mirrors GitHub's shape: ``state`` is ``"open"`` or ``"closed"``, and a
    merged PR has ``state="closed"`` with ``merged=True`` (GitHub does not
    expose ``"merged"`` as a separate state).
    """

    task = models.ForeignKey(
        "tasks.Task",
        on_delete=models.CASCADE,
        related_name="pull_requests",
    )
    repository = models.ForeignKey(
        ProjectRepository,
        on_delete=models.CASCADE,
        related_name="task_links",
    )
    pr_number = models.IntegerField()
    pr_title = models.CharField(max_length=500)
    state = models.CharField(max_length=20)
    merged = models.BooleanField(default=False)
    is_draft = models.BooleanField(default=False)
    head_ref = models.CharField(max_length=200)
    base_ref = models.CharField(max_length=200)
    html_url = models.URLField()
    author_login = models.CharField(max_length=200, blank=True, default="")
    reviewer_login = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text=(
            "GitHub login of the current requested/actual reviewer. Latest-"
            "event-wins single value (v1) — set by "
            "apps.integrations.rules.set_reviewer, cleared by "
            "clear_reviewer_if_matches on review_request_removed."
        ),
    )
    opened_at = models.DateTimeField()
    merged_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["task", "repository", "pr_number"],
                name="uniq_task_pr",
            ),
        ]
        indexes = [
            models.Index(fields=["repository", "pr_number"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.task.key} ↔ #{self.pr_number}"
