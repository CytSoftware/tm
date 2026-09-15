from unittest.mock import patch

import httpx
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from apps.tasks.models import Project, Task
from .github import GitHubUnavailable
from .models import ProjectRepository
from .test_repositories import REPO


class PullRequestTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.user = get_user_model().objects.create_user("reviewer")
        self.client.force_authenticate(self.user)
        self.project = Project.objects.create(name="Tracker", prefix="TM")
        self.task = Task.objects.create(project=self.project, title="Task title", reporter=self.user)
        ProjectRepository.objects.create(project=self.project, repo_id=42, repo_full_name="old/name")
        self.path = "/api/integrations/github/pull-requests/"
        self.calls = []

    def transport(self, request):
        self.calls.append(request)
        if request.method == "POST":
            self.assertEqual(request.url.path, "/app/installations/7/access_tokens")
            return httpx.Response(201, json={"token": "installation-token"})
        self.assertEqual(request.url.path, "/repos/CytSoftware/tm/pulls")
        page = int(request.url.params["page"])
        rows = [{
            "id": i, "number": i, "title": f"PR {i}", "body": self.task.key if i == 1 else "",
            "head": {"ref": "feature"}, "html_url": f"https://github.com/CytSoftware/tm/pull/{i}",
            "draft": False, "updated_at": "2026-09-15T12:00:00Z", "user": {"login": "author"},
            "requested_reviewers": [{"login": "alice"}, {"login": "bob"}],
            "requested_teams": [{"slug": "devs"}],
        } for i in (range(1, 101) if page == 1 else [101])]
        return httpx.Response(200, json=rows)

    def test_live_prs_pagination_optional_tasks_dedup_and_cache(self):
        other = Project.objects.create(name="Other", prefix="OTH")
        ProjectRepository.objects.create(project=other, repo_id=42, repo_full_name="old/name")
        client = httpx.Client(base_url="https://api.github.com", transport=httpx.MockTransport(self.transport))
        with patch("apps.integrations.pull_requests.available_repositories", return_value=[REPO]), patch(
            "apps.integrations.pull_requests.app_jwt", return_value="app-token"
        ), patch("apps.integrations.pull_requests.httpx.Client", return_value=client):
            response = self.client.get(self.path)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["results"]), 101)
        first, second = response.data["results"][:2]
        self.assertEqual(first["title"], "PR 1")
        self.assertEqual(first["tasks"], [self.task.key])
        self.assertEqual(second["tasks"], [])
        self.assertEqual(first["reviewers"], ["alice", "bob"])
        self.assertEqual(first["teams"], ["devs"])
        self.assertEqual(len(first["projects"]), 2)
        self.assertEqual(len(self.calls), 3)
        with patch("apps.integrations.pull_requests.available_repositories", return_value=[REPO]), patch(
            "apps.integrations.pull_requests.request", side_effect=AssertionError("must use cache")
        ):
            self.assertEqual(len(self.client.get(self.path).data["results"]), 101)
        self.assertFalse(self.task.pull_requests.exists())

    def test_refresh_bypasses_cache_and_reports_repository_failure(self):
        from django.conf import settings
        cache.set(f"github:pulls:{settings.GITHUB_APP_ID}:42", [{"stale": True}], 60)
        with patch("apps.integrations.pull_requests.available_repositories", return_value=[REPO]) as discover, patch(
            "apps.integrations.pull_requests.app_jwt", return_value="app-token"
        ), patch("apps.integrations.pull_requests.request", side_effect=GitHubUnavailable("GitHub denied access.")):
            response = self.client.get(self.path + "?refresh=true")
        discover.assert_called_once_with(refresh=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["results"], [])
        self.assertEqual(response.data["errors"], ["CytSoftware/tm: GitHub denied access."])

    def test_revoked_access_does_not_serve_cached_prs(self):
        with patch("apps.integrations.pull_requests.available_repositories", return_value=[]):
            response = self.client.get(self.path)
        self.assertEqual(response.data["results"], [])
        self.assertEqual(len(response.data["errors"]), 1)

    def test_anonymous_denied(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(self.path).status_code, 403)
