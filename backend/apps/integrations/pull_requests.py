"""Live open PRs from project repositories; task references are optional."""

import httpx
from django.conf import settings
from django.core.cache import cache
from rest_framework.response import Response
from rest_framework.views import APIView

from .github import GitHubUnavailable, app_jwt, available_repositories, pages, request
from .models import ProjectRepository
from .services import extract_task_keys


class GitHubPullRequestsView(APIView):
    def get(self, http_request):
        links = list(ProjectRepository.objects.select_related("project"))
        if not links:
            return Response({"results": [], "repositories": [], "errors": []})
        refresh = http_request.query_params.get("refresh") == "true"
        available = {r["repo_id"]: r for r in available_repositories(refresh=refresh)}
        grouped = {}
        for link in links:
            grouped.setdefault(link.repo_id, []).append(link)
        results, repositories, errors = [], [], []
        tokens = {}
        with httpx.Client(
            base_url="https://api.github.com", timeout=15,
            headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
        ) as client:
            for repo_id, repo_links in grouped.items():
                repo = available.get(repo_id)
                projects = [{"id": link.project_id, "name": link.project.name} for link in repo_links]
                name = repo["repo_full_name"] if repo else repo_links[0].repo_full_name
                repositories.append({"id": repo_id, "name": name, "projects": projects})
                if repo is None:
                    errors.append(f"{name}: the GitHub App cannot access this repository.")
                    continue
                cache_key = f"github:pulls:{settings.GITHUB_APP_ID}:{repo_id}"
                prs = None if refresh else cache.get(cache_key)
                try:
                    if prs is None:
                        installation_id = repo["installation_id"]
                        if installation_id not in tokens:
                            tokens[installation_id] = request(
                                client, "POST", f"/app/installations/{installation_id}/access_tokens", app_jwt(),
                                json={"permissions": {"pull_requests": "read"}},
                            )["token"]
                        # GitHub's list endpoint defaults to open PRs, including drafts.
                        prs = list(pages(client, f"/repos/{name}/pulls", tokens[installation_id]))
                        cache.set(cache_key, prs, 60)
                except GitHubUnavailable as exc:
                    errors.append(f"{name}: {exc.detail}")
                    continue
                for pr in prs:
                    keys = set()
                    for link in repo_links:
                        keys.update(extract_task_keys(link.project, pr["title"], pr.get("body"), pr["head"]["ref"]))
                    results.append({
                        "id": pr["id"], "number": pr["number"], "title": pr["title"],
                        "url": pr["html_url"], "draft": pr["draft"], "updated_at": pr["updated_at"],
                        "author": (pr.get("user") or {}).get("login", ""),
                        "reviewers": [u["login"] for u in pr.get("requested_reviewers", [])],
                        "teams": [t["slug"] for t in pr.get("requested_teams", [])],
                        "repository_id": repo_id, "repository": name, "projects": projects,
                        "tasks": sorted(keys),
                    })
        results.sort(key=lambda pr: pr["updated_at"], reverse=True)
        return Response({"results": results, "repositories": repositories, "errors": errors})
