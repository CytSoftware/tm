import json
from unittest.mock import patch

import httpx
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from apps.tasks.models import Project
from .github import GitHubUnavailable, app_jwt, available_repositories
from .models import ProjectRepository


REPO = {
    "repo_id": 42, "repo_full_name": "CytSoftware/tm", "default_branch": "main",
    "private": True, "archived": False, "installation_id": 7,
    "account_login": "CytSoftware", "account_type": "Organization",
}


class RepositoryLinkTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(get_user_model().objects.create_user("repo-owner"))
        self.project = Project.objects.create(name="Tracker", prefix="TM")
        self.path = f"/api/integrations/projects/{self.project.pk}/repositories/"

    @patch("apps.integrations.repositories.available_repositories", return_value=[REPO])
    def test_link_is_verified_and_idempotent(self, discover):
        for expected_status in (201, 200):
            response = self.client.post(self.path, {"repo_id": 42, "repo_full_name": "forged/repo"})
            self.assertEqual(response.status_code, expected_status)
            self.assertEqual(response.data["repo_full_name"], "CytSoftware/tm")
        discover.assert_called_with(refresh=True)
        self.assertEqual(self.project.repositories.count(), 1)
        link = self.project.repositories.get()
        self.assertEqual(link.installation.installation_id, 7)
        self.project.refresh_from_db()
        self.assertEqual(self.project.github_repo, "CytSoftware/tm")

    @patch("apps.integrations.repositories.available_repositories", return_value=[])
    def test_revoked_repo_cannot_be_linked(self, _):
        self.assertEqual(self.client.post(self.path, {"repo_id": 42}).status_code, 400)
        self.assertFalse(self.project.repositories.exists())

    @patch("apps.integrations.repositories.available_repositories", side_effect=GitHubUnavailable())
    def test_github_failure_keeps_existing_links(self, _):
        ProjectRepository.objects.create(project=self.project, repo_id=42, repo_full_name="CytSoftware/tm")
        self.assertEqual(self.client.post(self.path, {"repo_id": 43}).status_code, 503)
        self.assertEqual(self.project.repositories.count(), 1)

    def test_unlink_is_project_scoped_and_updates_shortcut(self):
        other = Project.objects.create(name="Other", prefix="OTH")
        for project in (self.project, other):
            ProjectRepository.objects.create(project=project, repo_id=42, repo_full_name="CytSoftware/tm")
        ProjectRepository.objects.create(project=self.project, repo_id=43, repo_full_name="CytSoftware/docs")
        self.project.github_repo = "CytSoftware/tm"
        self.project.save()
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(self.path, {"repo_id": 42}, format="json")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(other.repositories.count(), 1)
        self.project.refresh_from_db()
        self.assertEqual(self.project.github_repo, "CytSoftware/docs")

    def test_anonymous_cannot_discover_or_change_links(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/integrations/github/repositories/").status_code, 403)
        self.assertEqual(self.client.post(self.path, {"repo_id": 42}).status_code, 403)

    def test_invalid_id_is_rejected(self):
        self.assertEqual(self.client.post(self.path, {"repo_id": "../bad"}).status_code, 400)

    @patch("apps.integrations.repositories.available_repositories", return_value=[REPO])
    def test_existing_manual_link_is_upgraded_in_place(self, _):
        link = ProjectRepository.objects.create(project=self.project, repo_id=42, repo_full_name="CytSoftware/old-name")
        response = self.client.post(self.path, {"repo_id": 42})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["id"], link.pk)
        self.assertEqual(response.data["installation_id"], 7)
        self.assertEqual(self.client.get(self.path).data["results"][0]["repo_full_name"], "CytSoftware/tm")


@override_settings(GITHUB_APP_ID="test-app")
class GitHubDiscoveryTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    @override_settings(GITHUB_PRIVATE_KEY="")
    def test_missing_configuration_is_actionable(self):
        with self.assertRaisesMessage(GitHubUnavailable, "Configure the GitHub App"):
            app_jwt()

    @patch("apps.integrations.github.app_jwt", return_value="app-token")
    def test_discovery_paginates_and_caches_without_exposing_tokens(self, _):
        calls = []

        def handler(request):
            calls.append(request.url.path)
            if request.url.path == "/app/installations":
                self.assertEqual(request.headers["authorization"], "Bearer app-token")
                return httpx.Response(200, json=[
                    {"id": 7, "account": {"login": "CytSoftware", "type": "Organization"}},
                    {"id": 8, "suspended_at": "2026-01-01", "account": {}},
                ])
            if request.method == "POST":
                self.assertEqual(json.loads(request.content), {"permissions": {"metadata": "read"}})
                return httpx.Response(201, json={"token": "private-installation-token"})
            self.assertEqual(request.headers["authorization"], "Bearer private-installation-token")
            page = int(request.url.params["page"])
            rows = [
                {"id": i, "full_name": f"CytSoftware/repo{i}", "default_branch": "main", "private": True, "archived": False}
                for i in (range(100) if page == 1 else [100])
            ]
            return httpx.Response(200, json={"repositories": rows})

        client = httpx.Client(base_url="https://api.github.com", transport=httpx.MockTransport(handler))
        with patch("apps.integrations.github.httpx.Client", return_value=client):
            result = available_repositories()
            self.assertEqual(len(result), 101)
            self.assertNotIn("private-installation-token", json.dumps(result))
            self.assertEqual(available_repositories(), result)
        self.assertEqual(len(calls), 4)

    @patch("apps.integrations.github.app_jwt", return_value="app-token")
    def test_rate_limit_is_an_error_not_an_empty_list(self, _):
        client = httpx.Client(base_url="https://api.github.com", transport=httpx.MockTransport(
            lambda _: httpx.Response(403, json={"message": "rate limit"}),
        ))
        with patch("apps.integrations.github.httpx.Client", return_value=client):
            with self.assertRaisesMessage(GitHubUnavailable, "GitHub denied access"):
                available_repositories()
        self.assertIsNone(cache.get("github:repositories:test-app"))
