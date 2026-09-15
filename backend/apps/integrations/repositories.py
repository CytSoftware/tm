"""Workspace-wide project/repository links, verified against GitHub App access."""

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.tasks.broadcast import broadcast_task_event
from apps.tasks.models import Project
from .github import available_repositories
from .models import GitHubInstallation, ProjectRepository
from .serializers import ProjectRepositoryNestedSerializer


class RepositoryChoice(serializers.Serializer):
    repo_id = serializers.IntegerField(min_value=1)


class GitHubRepositoriesView(APIView):
    def get(self, request):
        return Response({"results": available_repositories(refresh=request.query_params.get("refresh") == "true")})


class ProjectRepositoriesView(APIView):
    def get(self, request, project_id):
        project = get_object_or_404(Project, pk=project_id)
        return Response({"results": ProjectRepositoryNestedSerializer(
            project.repositories.select_related("installation").order_by("repo_full_name"), many=True,
        ).data})

    def post(self, request, project_id):
        get_object_or_404(Project, pk=project_id)
        choice = RepositoryChoice(data=request.data)
        choice.is_valid(raise_exception=True)
        repo_id = choice.validated_data["repo_id"]
        # Fresh discovery prevents stale picker entries granting revoked access.
        repo = next((r for r in available_repositories(refresh=True) if r["repo_id"] == repo_id), None)
        if repo is None:
            raise ValidationError({"repo_id": "The GitHub App cannot access this repository. Refresh the list."})
        with transaction.atomic():
            project = Project.objects.select_for_update().get(pk=project_id)
            installation, _ = GitHubInstallation.objects.update_or_create(
                installation_id=repo["installation_id"],
                defaults={"account_login": repo["account_login"], "account_type": repo["account_type"], "suspended_at": None},
            )
            link, created = ProjectRepository.objects.update_or_create(
                project=project, repo_id=repo_id,
                defaults={"installation": installation, "repo_full_name": repo["repo_full_name"], "default_branch": repo["default_branch"]},
            )
            # Keep the existing board shortcut aligned with the first linked repo.
            if not project.github_repo or project.repositories.count() == 1:
                project.github_repo = link.repo_full_name
                project.save(update_fields=["github_repo", "updated_at"])
            transaction.on_commit(lambda: broadcast_task_event(project_id, "project.updated", {"id": project_id}))
        return Response(ProjectRepositoryNestedSerializer(link).data, status=201 if created else 200)

    def delete(self, request, project_id):
        choice = RepositoryChoice(data=request.data)
        choice.is_valid(raise_exception=True)
        with transaction.atomic():
            project = get_object_or_404(Project.objects.select_for_update(), pk=project_id)
            link = get_object_or_404(project.repositories, repo_id=choice.validated_data["repo_id"])
            removed_name = link.repo_full_name
            link.delete()
            if project.github_repo == removed_name:
                project.github_repo = project.repositories.order_by("id").values_list("repo_full_name", flat=True).first() or ""
                project.save(update_fields=["github_repo", "updated_at"])
            transaction.on_commit(lambda: broadcast_task_event(project_id, "project.updated", {"id": project_id}))
        return Response(status=204)
