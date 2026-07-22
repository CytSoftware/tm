"""Unit tests for the P0 GitHub integration slice."""

from __future__ import annotations

import hashlib
import hmac
import json

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from apps.integrations.models import (
    EventSource,
    EventWorkflowStatus,
    ExternalEvent,
    ProjectRepository,
    TaskPullRequest,
)
from apps.integrations.services import (
    apply_pull_request_event,
    extract_task_keys,
)
from apps.tasks.models import Project, Task

User = get_user_model()


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()


def _pr_payload(
    *,
    number: int = 42,
    title: str = "[CYT-001] Fix bug",
    body: str = "",
    state: str = "open",
    merged: bool = False,
    draft: bool = False,
    head_ref: str = "feature/cyt-001-fix",
    base_ref: str = "main",
    repo_id: int = 999,
    repo_full_name: str = "owner/repo",
    default_branch: str = "main",
) -> dict:
    return {
        "action": "opened",
        "pull_request": {
            "number": number,
            "title": title,
            "body": body,
            "state": state,
            "merged": merged,
            "draft": draft,
            "head": {"ref": head_ref},
            "base": {"ref": base_ref},
            "html_url": f"https://github.com/{repo_full_name}/pull/{number}",
            "user": {"login": "alice"},
            "created_at": "2026-04-15T10:00:00Z",
            "merged_at": None,
            "closed_at": None,
        },
        "repository": {
            "id": repo_id,
            "full_name": repo_full_name,
            "default_branch": default_branch,
        },
    }


class ExtractTaskKeysTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.reporter = User.objects.create_user(username="alice")
        cls.project = Project.objects.create(name="Cyt", prefix="CYT")
        cls.task1 = Task.objects.create(
            project=cls.project, title="One", reporter=cls.reporter
        )
        cls.task2 = Task.objects.create(
            project=cls.project, title="Two", reporter=cls.reporter
        )
        cls.task3 = Task.objects.create(
            project=cls.project, title="Three", reporter=cls.reporter
        )

    def test_pr_title_bracketed(self):
        self.assertEqual(
            extract_task_keys(self.project, "[CYT-001] Add feature"),
            ["CYT-001"],
        )

    def test_pr_body_multiple_keys(self):
        keys = extract_task_keys(
            self.project,
            None,
            "Closes CYT-001, CYT-002 and fixes CYT-999 later",
        )
        # CYT-999 doesn't exist so it's filtered.
        self.assertEqual(keys, ["CYT-001", "CYT-002"])

    def test_branch_name_lowercase(self):
        self.assertEqual(
            extract_task_keys(self.project, None, None, "feature/cyt-003-foo"),
            ["CYT-003"],
        )

    def test_cross_project_prefix_ignored(self):
        self.assertEqual(
            extract_task_keys(self.project, "ALPHA-007 and CYT-001 together"),
            ["CYT-001"],
        )

    def test_unpadded_digit_normalized(self):
        self.assertEqual(
            extract_task_keys(self.project, "Refs CYT-1 here"),
            ["CYT-001"],
        )

    def test_four_digit_key(self):
        # A key longer than the default padding still matches structurally,
        # but it won't exist, so we expect an empty result.
        self.assertEqual(extract_task_keys(self.project, "CYT-1000"), [])

    def test_embedded_not_matched(self):
        # Boundary lookarounds reject CYT-001 embedded in a longer identifier.
        self.assertEqual(
            extract_task_keys(self.project, "ABCCYT-001 and CYT-001X"),
            [],
        )

    def test_empty_prefix(self):
        empty = Project.objects.create(name="Prefixless", prefix="")
        self.assertEqual(
            extract_task_keys(empty, "mentions CYT-001 here"),
            [],
        )


@override_settings(GITHUB_WEBHOOK_SECRET="test-secret")
class WebhookViewTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.reporter = User.objects.create_user(username="alice")
        cls.project = Project.objects.create(name="Cyt", prefix="CYT")
        cls.task = Task.objects.create(
            project=cls.project, title="One", reporter=cls.reporter
        )
        cls.repo = ProjectRepository.objects.create(
            project=cls.project,
            repo_id=999,
            repo_full_name="owner/repo",
            default_branch="main",
        )

    def setUp(self):
        # locmem cache is process-global across test cases; clear the
        # delivery dedup entries between tests so duplicate assertions are
        # deterministic.
        cache.clear()

    def _post(
        self,
        body: dict,
        *,
        event: str = "pull_request",
        delivery: str = "abc",
        sign: bool = True,
        secret: str = "test-secret",
    ):
        raw = json.dumps(body).encode("utf-8")
        headers = {
            "HTTP_X_GITHUB_EVENT": event,
            "HTTP_X_GITHUB_DELIVERY": delivery,
        }
        if sign:
            headers["HTTP_X_HUB_SIGNATURE_256"] = _sign(raw, secret)
        return self.client.post(
            "/api/integrations/github/webhook/",
            data=raw,
            content_type="application/json",
            **headers,
        )

    def test_valid_pr_opened_links_task(self):
        resp = self._post(_pr_payload(), delivery="d-1")
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["ok"], True)
        self.assertEqual(data["tasks_linked"], 1)
        link = TaskPullRequest.objects.get(task=self.task)
        self.assertEqual(link.pr_number, 42)
        self.assertEqual(link.state, "open")
        self.assertFalse(link.merged)

    def test_invalid_signature_rejected(self):
        resp = self._post(_pr_payload(), delivery="d-2", sign=False)
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(TaskPullRequest.objects.exists())

    def test_wrong_secret_rejected(self):
        resp = self._post(_pr_payload(), delivery="d-3", secret="wrong")
        self.assertEqual(resp.status_code, 403)

    def test_duplicate_delivery_ignored(self):
        resp1 = self._post({"zen": "hello"}, event="ping", delivery="dup-1")
        self.assertEqual(resp1.status_code, 200)
        resp2 = self._post({"zen": "hello"}, event="ping", delivery="dup-1")
        self.assertEqual(resp2.status_code, 200)
        self.assertTrue(resp2.json().get("duplicate"))

    def test_unknown_repo_silently_ignored(self):
        resp = self._post(
            _pr_payload(repo_id=11111, repo_full_name="unknown/repo"),
            delivery="d-4",
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["tasks_linked"], 0)
        self.assertFalse(TaskPullRequest.objects.exists())

    def test_multi_project_fan_out(self):
        project2 = Project.objects.create(name="Alpha", prefix="ALPHA")
        alpha_task = Task.objects.create(
            project=project2, title="Alpha one", reporter=self.reporter
        )
        ProjectRepository.objects.create(
            project=project2,
            repo_id=999,
            repo_full_name="owner/repo",
            default_branch="main",
        )
        payload = _pr_payload(
            title="[CYT-001] and [ALPHA-001] together",
            head_ref="multi",
            number=7,
        )
        resp = self._post(payload, delivery="d-5")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["tasks_linked"], 2)
        self.assertEqual(data["projects_matched"], 2)
        self.assertTrue(TaskPullRequest.objects.filter(task=self.task).exists())
        self.assertTrue(
            TaskPullRequest.objects.filter(task=alpha_task).exists()
        )

    def test_reconcile_removes_stale_link(self):
        # First event links CYT-001.
        self._post(_pr_payload(number=10, title="[CYT-001]"), delivery="d-6a")
        self.assertEqual(TaskPullRequest.objects.count(), 1)
        # Second event (edited PR title) drops CYT-001 entirely.
        self._post(
            _pr_payload(number=10, title="Unrelated edit", head_ref="unrelated"),
            delivery="d-6b",
        )
        self.assertEqual(TaskPullRequest.objects.count(), 0)


class ApplyPullRequestEventUnitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.reporter = User.objects.create_user(username="alice")
        cls.project = Project.objects.create(name="Cyt", prefix="CYT")
        cls.task = Task.objects.create(
            project=cls.project, title="One", reporter=cls.reporter
        )
        ProjectRepository.objects.create(
            project=cls.project,
            repo_id=999,
            repo_full_name="owner/repo",
            default_branch="main",
        )

    def test_merged_pr_records_merge_flag(self):
        payload = _pr_payload(
            number=100,
            title="[CYT-001] ship",
            state="closed",
            merged=True,
        )
        payload["pull_request"]["merged_at"] = "2026-04-15T11:00:00Z"
        payload["pull_request"]["closed_at"] = "2026-04-15T11:00:00Z"
        result = apply_pull_request_event(payload)
        self.assertEqual(result.tasks_linked, 1)
        link = TaskPullRequest.objects.get()
        self.assertTrue(link.merged)
        self.assertEqual(link.state, "closed")
        self.assertIsNotNone(link.merged_at)

    def test_repo_full_name_refreshed(self):
        payload = _pr_payload(
            title="[CYT-001]",
            repo_full_name="owner/renamed",
        )
        apply_pull_request_event(payload)
        repo = ProjectRepository.objects.get(repo_id=999)
        self.assertEqual(repo.repo_full_name, "owner/renamed")


class EventInboxTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="event-owner", password="pw")
        self.other = User.objects.create_user(username="other-owner", password="pw")
        self.client.force_login(self.user)

    def create_source(self, *, provider="generic", name="Alerts"):
        response = self.client.post(
            "/api/integrations/event-sources/",
            data=json.dumps({"name": name, "provider": provider}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        return EventSource.objects.get(pk=response.json()["id"]), response.json()

    def ingest(self, source, payload):
        return self.client.post(
            f"/api/integrations/event-sources/{source.token}/ingest/",
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_source_create_returns_public_webhook_url(self):
        source, body = self.create_source()
        self.assertEqual(source.user, self.user)
        self.assertEqual(body["icon"], "activity")
        self.assertEqual(body["columns"], [])
        self.assertIn(str(source.token), body["webhook_url"])
        self.assertTrue(body["webhook_url"].endswith("/ingest/"))

    def test_source_page_configuration_is_persisted_and_validated(self):
        source, _ = self.create_source()
        columns = [
            {"id": "workflow_status", "label": "Status", "visible": True},
            {"id": "payload:monitor.url", "label": "URL", "visible": True},
        ]
        response = self.client.patch(
            f"/api/integrations/event-sources/{source.pk}/",
            data=json.dumps(
                {"name": "Website uptime", "icon": "globe", "columns": columns}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        source.refresh_from_db()
        self.assertEqual(source.name, "Website uptime")
        self.assertEqual(source.icon, "globe")
        self.assertEqual(source.columns, columns)

        invalid = self.client.patch(
            f"/api/integrations/event-sources/{source.pk}/",
            data=json.dumps(
                {"columns": [{"id": "title", "label": "Title", "visible": "yes"}]}
            ),
            content_type="application/json",
        )
        self.assertEqual(invalid.status_code, 400)

    def test_generic_event_is_created_and_upserted(self):
        source, _ = self.create_source()
        first = self.ingest(
            source,
            {
                "id": "incident-1",
                "title": "Checkout failed",
                "severity": "critical",
                "status": "open",
                "timestamp": "2026-07-22T10:00:00Z",
                "details": {"region": "eu"},
            },
        )
        self.assertEqual(first.status_code, 201, first.content)
        event = ExternalEvent.objects.get(source=source)
        self.assertEqual(event.title, "Checkout failed")
        self.assertEqual(event.severity, "critical")
        self.assertEqual(event.occurrence_count, 1)

        event.workflow_status = EventWorkflowStatus.FIXED
        event.save(update_fields=["workflow_status"])
        second = self.ingest(
            source,
            {"id": "incident-1", "title": "Checkout still failing", "status": "open"},
        )
        self.assertEqual(second.status_code, 200, second.content)
        event.refresh_from_db()
        self.assertEqual(event.title, "Checkout still failing")
        self.assertEqual(event.occurrence_count, 2)
        self.assertEqual(event.workflow_status, EventWorkflowStatus.FIXED)

    def test_sentry_issue_normalization(self):
        source, _ = self.create_source(provider="sentry", name="Sentry")
        response = self.ingest(
            source,
            {
                "action": "created",
                "data": {
                    "issue": {
                        "id": "9988",
                        "shortId": "API-12",
                        "title": "TypeError in checkout",
                        "level": "error",
                        "status": "unresolved",
                        "permalink": "https://sentry.example/issues/9988",
                        "lastSeen": "2026-07-22T11:00:00Z",
                    }
                },
            },
        )
        self.assertEqual(response.status_code, 201, response.content)
        event = ExternalEvent.objects.get(source=source)
        self.assertEqual(event.external_id, "9988")
        self.assertEqual(event.title, "TypeError in checkout")
        self.assertEqual(event.severity, "error")
        self.assertEqual(event.provider_status, "unresolved")

    def test_uptime_kuma_monitor_is_one_trackable_row(self):
        source, _ = self.create_source(provider="uptime_kuma", name="Uptime")
        down = {
            "heartbeat": {"status": 0, "time": "2026-07-22T11:00:00Z"},
            "monitor": {"id": 7, "name": "Website", "url": "https://example.com"},
            "msg": "Website is down",
        }
        up = {
            "heartbeat": {"status": 1, "time": "2026-07-22T11:05:00Z"},
            "monitor": {"id": 7, "name": "Website", "url": "https://example.com"},
            "msg": "Website is up",
        }
        self.ingest(source, down)
        response = self.ingest(source, up)
        self.assertEqual(response.status_code, 200, response.content)
        event = ExternalEvent.objects.get(source=source)
        self.assertEqual(event.provider_status, "up")
        self.assertEqual(event.severity, "info")
        self.assertEqual(event.occurrence_count, 2)

    def test_inactive_source_and_invalid_payload_are_rejected(self):
        source, _ = self.create_source()
        source.active = False
        source.save(update_fields=["active"])
        self.assertEqual(self.ingest(source, {"id": "x"}).status_code, 404)

        source.active = True
        source.save(update_fields=["active"])
        response = self.client.post(
            f"/api/integrations/event-sources/{source.token}/ingest/",
            data="not-json",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_event_list_update_summary_and_user_scope(self):
        source, _ = self.create_source()
        self.ingest(source, {"id": "a", "title": "One"})
        self.ingest(source, {"id": "b", "title": "Two"})
        event = ExternalEvent.objects.get(source=source, external_id="a")

        patch = self.client.patch(
            f"/api/integrations/events/{event.pk}/",
            data=json.dumps({"workflow_status": "fixed"}),
            content_type="application/json",
        )
        self.assertEqual(patch.status_code, 200, patch.content)
        summary = self.client.get("/api/integrations/events/summary/")
        self.assertEqual(summary.status_code, 200, summary.content)
        self.assertEqual(summary.json()["total"], 2)
        self.assertEqual(summary.json()["fixed"], 1)
        self.assertEqual(summary.json()["new"], 1)

        other_source = EventSource.objects.create(user=self.other, name="Private")
        ExternalEvent.objects.create(
            source=other_source, external_id="private", title="Private event"
        )
        listing = self.client.get("/api/integrations/events/")
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual(listing.json()["count"], 2)
        self.assertNotContains(listing, "Private event")
