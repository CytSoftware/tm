"""Tests for the outbound webhook system.

Self-contained (there is no wider test suite yet). Run with:

    uv run python manage.py test apps.webhooks

All outbound HTTP is mocked — ``urllib.request.urlopen`` is patched at the
``apps.webhooks.delivery`` module level, so no real network I/O happens.
Dispatch normally hands first attempts to a daemon thread; tests patch
``threading.Thread`` at the ``apps.webhooks.dispatch`` level to run the batch
inline for determinism.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import types
import urllib.error
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tasks.models import Notification, Project, Task
from apps.tasks.notifications import notify_task_event

from .delivery import (
    attempt_delivery,
    build_envelope,
    process_due_deliveries,
    serialize_body,
    sign_payload,
)
from .dispatch import dispatch_task_webhooks, enqueue_test_delivery
from .models import WebhookDelivery, WebhookDeliveryStatus, WebhookEndpoint, WebhookScope
from .serializers import WebhookEndpointSerializer

User = get_user_model()


class _InlineThread:
    """threading.Thread stand-in that runs its target synchronously on start()."""

    def __init__(self, *, target=None, daemon=None, **kwargs):
        self._target = target

    def start(self):
        if self._target:
            self._target()


#: Patch target for dispatch's ``threading`` *name* only — patching
#: ``threading.Thread`` itself would leak into every other thread user
#: (asgiref's executor, most notably).
_inline_threading = types.SimpleNamespace(Thread=_InlineThread)


def _fake_response(status=200, body=b"ok"):
    resp = mock.MagicMock()
    resp.status = status
    resp.read.return_value = body
    resp.__enter__.return_value = resp
    return resp


def _make_endpoint(user, **overrides):
    defaults = dict(
        user=user,
        name="test endpoint",
        url="http://127.0.0.1:9/hook",  # port 9 (discard) — never actually hit
        secret="a" * 64,
        event_types=[],
        project=None,
        include_self=False,
        active=True,
    )
    defaults.update(overrides)
    return WebhookEndpoint.objects.create(**defaults)


class WebhookTestBase(TestCase):
    def setUp(self):
        self.chris = User.objects.create_user("chris", "chris@example.com", "x")
        self.dana = User.objects.create_user("dana", "dana@example.com", "x")
        self.project = Project.objects.create(name="Cyt", prefix="CYT")
        self.other_project = Project.objects.create(name="Other", prefix="OTH")
        self.task = Task.objects.create(
            project=self.project,
            column=self.project.columns.first(),
            title="Do the thing",
            reporter=self.chris,
        )

    def dispatch(self, *, task=None, actor=None, verb="assigned", recipients=(), extra=None):
        """Run dispatch with the daemon thread inlined and urlopen mocked.

        Dispatch defers its first-attempt thread to ``transaction.on_commit``.
        ``TestCase`` wraps each test in a transaction that never commits, so we
        capture and execute the on-commit callbacks explicitly — this also
        exercises the real commit-gated path.
        """
        with (
            mock.patch("apps.webhooks.dispatch.threading", _inline_threading),
            mock.patch(
                "apps.webhooks.delivery.urllib.request.urlopen",
                return_value=_fake_response(),
            ) as urlopen,
        ):
            with self.captureOnCommitCallbacks(execute=True):
                dispatch_task_webhooks(
                    task=task if task is not None else self.task,
                    actor=actor,
                    verb=verb,
                    recipients=list(recipients),
                    extra=extra or {},
                )
        return urlopen


class DispatchFilteringTests(WebhookTestBase):
    def test_recipient_endpoint_fires(self):
        ep = _make_endpoint(self.dana)
        self.dispatch(actor=self.chris, recipients=[self.dana])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)
        self.assertEqual(d.event, "assigned")
        self.assertEqual(d.status, WebhookDeliveryStatus.SUCCESS)
        self.assertEqual(d.task_key, self.task.key)
        self.assertEqual(d.payload["recipient"]["id"], self.dana.id)
        self.assertEqual(d.payload["actor"]["id"], self.chris.id)

    def test_verb_filter_blocks_other_verbs(self):
        _make_endpoint(self.dana, event_types=["moved"])
        self.dispatch(actor=self.chris, verb="assigned", recipients=[self.dana])
        self.assertEqual(WebhookDelivery.objects.count(), 0)
        self.dispatch(actor=self.chris, verb="moved", recipients=[self.dana])
        self.assertEqual(WebhookDelivery.objects.count(), 1)

    def test_empty_event_types_means_all_verbs(self):
        _make_endpoint(self.dana, event_types=[])
        for verb in ("assigned", "updated", "moved", "completed", "deleted"):
            self.dispatch(actor=self.chris, verb=verb, recipients=[self.dana])
        self.assertEqual(WebhookDelivery.objects.count(), 5)

    def test_project_scope_blocks_other_project(self):
        _make_endpoint(self.dana, project=self.other_project)
        self.dispatch(actor=self.chris, recipients=[self.dana])
        self.assertEqual(WebhookDelivery.objects.count(), 0)

    def test_project_scope_matches_same_project(self):
        _make_endpoint(self.dana, project=self.project)
        self.dispatch(actor=self.chris, recipients=[self.dana])
        self.assertEqual(WebhookDelivery.objects.count(), 1)

    def test_inbox_task_only_matches_unscoped_endpoints(self):
        inbox_task = Task.objects.create(title="inbox", reporter=self.chris)
        _make_endpoint(self.dana, project=self.project, name="scoped")
        unscoped = _make_endpoint(self.dana, name="unscoped")
        self.dispatch(task=inbox_task, actor=self.chris, recipients=[self.dana])
        deliveries = WebhookDelivery.objects.all()
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0].endpoint_id, unscoped.id)
        # Inbox envelope has null project/column.
        self.assertIsNone(deliveries[0].payload["task"]["project_id"])
        self.assertIsNone(deliveries[0].payload["task"]["column"])

    def test_actor_without_include_self_does_not_fire(self):
        _make_endpoint(self.chris, include_self=False)
        # Actor is the only interested user — recipients list is empty
        # (notifications layer excludes self-actions).
        self.dispatch(actor=self.chris, recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 0)

    def test_actor_with_include_self_fires(self):
        ep = _make_endpoint(self.chris, include_self=True)
        self.dispatch(actor=self.chris, recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)
        self.assertEqual(d.payload["recipient"]["id"], self.chris.id)

    def test_inactive_endpoint_never_matches(self):
        _make_endpoint(self.dana, active=False)
        self.dispatch(actor=self.chris, recipients=[self.dana])
        self.assertEqual(WebhookDelivery.objects.count(), 0)

    def test_system_actor_none_fires_for_recipients(self):
        _make_endpoint(self.dana)
        self.dispatch(actor=None, recipients=[self.dana])
        d = WebhookDelivery.objects.get()
        self.assertIsNone(d.payload["actor"])

    def test_extra_passthrough_in_data(self):
        _make_endpoint(self.dana)
        self.dispatch(
            actor=self.chris,
            verb="moved",
            recipients=[self.dana],
            extra={"from_column": "Todo", "to_column": "Done"},
        )
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.payload["data"], {"from_column": "Todo", "to_column": "Done"})

    def test_dispatch_never_raises(self):
        # Even with a broken task object, the public entry point must swallow.
        dispatch_task_webhooks(
            task=object(), actor=self.chris, verb="assigned", recipients=[self.dana]
        )

    def test_envelope_contains_recipients_array(self):
        _make_endpoint(self.dana)
        self.dispatch(actor=self.chris, recipients=[self.dana])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.payload["recipients"], [{"id": self.dana.id, "username": "dana"}])

    def test_envelope_recipients_empty_when_no_recipients(self):
        _make_endpoint(self.chris, include_self=True)
        self.dispatch(actor=self.chris, recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.payload["recipients"], [])


class ScopeAllTests(WebhookTestBase):
    """scope="all" endpoints: org-wide, regardless of who acted/was assigned."""

    def test_scope_all_fires_for_uninvolved_owner(self):
        # Owner (chris) is neither actor nor recipient of this event.
        ep = _make_endpoint(self.chris, scope=WebhookScope.ALL)
        self.dispatch(actor=self.dana, recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)
        self.assertEqual(d.payload["recipient"]["id"], self.chris.id)
        self.assertEqual(d.payload["actor"]["id"], self.dana.id)

    def test_scope_all_matches_unassigned_task_update(self):
        # No recipients, no include_self needed — org-wide catches it all.
        ep = _make_endpoint(self.chris, scope=WebhookScope.ALL)
        self.dispatch(actor=self.dana, verb="updated", recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)

    def test_scope_mine_does_not_fire_without_involvement(self):
        # Same event, but a scope="mine" endpoint owned by an uninvolved user
        # must NOT match.
        _make_endpoint(self.chris, scope=WebhookScope.MINE)
        self.dispatch(actor=self.dana, verb="updated", recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 0)

    def test_scope_all_matches_system_actor_none(self):
        # Recurring-generator-style event: actor=None, recipients=[].
        ep = _make_endpoint(self.chris, scope=WebhookScope.ALL)
        self.dispatch(actor=None, verb="created", recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)
        self.assertIsNone(d.payload["actor"])

    def test_scope_all_ignores_include_self_flag(self):
        # include_self is meaningless for scope="all" — the owner acting
        # themself still matches (org-wide means org-wide).
        ep = _make_endpoint(self.chris, scope=WebhookScope.ALL, include_self=False)
        self.dispatch(actor=self.chris, recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)

    def test_scope_all_respects_verb_filter(self):
        _make_endpoint(self.chris, scope=WebhookScope.ALL, event_types=["moved"])
        self.dispatch(actor=self.dana, verb="assigned", recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 0)
        self.dispatch(actor=self.dana, verb="moved", recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 1)

    def test_scope_all_respects_project_filter(self):
        _make_endpoint(self.chris, scope=WebhookScope.ALL, project=self.other_project)
        self.dispatch(actor=self.dana, recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 0)

        _make_endpoint(self.dana, scope=WebhookScope.ALL, project=self.project)
        self.dispatch(actor=self.chris, recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 1)

    def test_scope_mine_regression_unaffected_by_scope_all_endpoints(self):
        # A pre-existing scope="mine" endpoint keeps its exact v1 matching
        # behavior alongside a scope="all" endpoint on the same event.
        mine_ep = _make_endpoint(self.dana, scope=WebhookScope.MINE)
        all_ep = _make_endpoint(self.chris, scope=WebhookScope.ALL)
        self.dispatch(actor=self.chris, recipients=[self.dana])
        deliveries = {d.endpoint_id for d in WebhookDelivery.objects.all()}
        self.assertEqual(deliveries, {mine_ep.id, all_ep.id})

    def test_scope_all_default_is_mine(self):
        self.assertEqual(WebhookEndpoint._meta.get_field("scope").default, WebhookScope.MINE)


class WebhookOnlyCreatedVerbTests(WebhookTestBase):
    """The "created" verb: webhook-only, never an in-app notification."""

    def test_created_dispatches_with_empty_recipients(self):
        ep = _make_endpoint(self.chris, scope=WebhookScope.ALL)
        self.dispatch(actor=self.dana, verb="created", recipients=[])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.endpoint_id, ep.id)
        self.assertEqual(d.event, "created")
        self.assertEqual(d.payload["recipients"], [])

    def test_created_via_notify_task_event_creates_no_notification_rows(self):
        _make_endpoint(self.chris, scope=WebhookScope.ALL)
        with (
            mock.patch("apps.webhooks.dispatch.threading", _inline_threading),
            mock.patch(
                "apps.webhooks.delivery.urllib.request.urlopen",
                return_value=_fake_response(),
            ),
        ):
            with self.captureOnCommitCallbacks(execute=True):
                notify_task_event(self.task, self.dana, "created", recipients=[])
        self.assertEqual(WebhookDelivery.objects.count(), 1)
        self.assertEqual(Notification.objects.count(), 0)

    def test_created_via_notify_task_event_guard_even_with_recipients(self):
        # Belt-and-suspenders: even if a future caller passes recipients for
        # a webhook-only verb, no Notification rows are created.
        notify_task_event(self.task, self.dana, "created", recipients=[self.chris])
        self.assertEqual(Notification.objects.count(), 0)


class SigningTests(WebhookTestBase):
    def test_serialization_is_deterministic(self):
        a = serialize_body({"b": 1, "a": {"y": 2, "x": 1}})
        b = serialize_body({"a": {"x": 1, "y": 2}, "b": 1})
        self.assertEqual(a, b)

    def test_signature_deterministic_and_tamper_evident(self):
        secret = "s3cret"
        body = serialize_body({"event": "task.assigned", "id": "abc"})
        ts = 1751900000
        sig1 = sign_payload(secret, body, ts)
        sig2 = sign_payload(secret, body, ts)
        self.assertEqual(sig1, sig2)
        self.assertTrue(sig1.startswith("sha256="))
        # Any change to body, ts, or secret changes the signature.
        self.assertNotEqual(sig1, sign_payload(secret, body + b" ", ts))
        self.assertNotEqual(sig1, sign_payload(secret, body, ts + 1))
        self.assertNotEqual(sig1, sign_payload("other", body, ts))

    def test_receiver_side_verification_round_trip(self):
        """A receiver re-deriving the HMAC accepts a genuine signature."""
        secret = "s3cret"
        payload = build_envelope(
            delivery_id=__import__("uuid").uuid4(),
            event="task.assigned",
            actor=self.chris,
            recipient=self.dana,
            task=self.task,
        )
        body = serialize_body(payload)
        ts = 1751900000
        header = sign_payload(secret, body, ts)
        # Receiver-side re-derivation (mirrors apps/integrations/webhooks.py).
        expected = "sha256=" + hmac.new(
            secret.encode(), f"{ts}.".encode() + body, hashlib.sha256
        ).hexdigest()
        self.assertTrue(hmac.compare_digest(expected, header))
        # Receiver can re-serialize parsed JSON and get identical bytes.
        self.assertEqual(serialize_body(json.loads(body)), body)


class DeliveryHeaderTests(WebhookTestBase):
    def test_post_headers_and_body(self):
        ep = _make_endpoint(self.dana, secret="b" * 64)
        urlopen = self.dispatch(actor=self.chris, recipients=[self.dana])
        (req,), kwargs = urlopen.call_args
        self.assertEqual(req.get_full_url(), ep.url)
        self.assertEqual(req.get_method(), "POST")
        d = WebhookDelivery.objects.get()
        self.assertEqual(req.get_header("X-cyt-webhook-id"), str(d.id))
        self.assertEqual(req.get_header("X-cyt-event"), "assigned")
        self.assertEqual(req.get_header("Content-type"), "application/json")
        ts = int(req.get_header("X-cyt-timestamp"))
        self.assertEqual(
            req.get_header("X-cyt-signature"),
            sign_payload(ep.secret, req.data, ts),
        )
        self.assertEqual(json.loads(req.data)["id"], str(d.id))


class BackoffTests(WebhookTestBase):
    def _pending_delivery(self, endpoint):
        return enqueue_test_delivery(endpoint)

    def test_backoff_schedule_then_terminal_failure(self):
        ep = _make_endpoint(self.dana)
        delivery = self._pending_delivery(ep)
        schedule = [60, 300, 1800, 7200, 43200]

        for i, backoff in enumerate(schedule, start=1):
            before = timezone.now()
            with mock.patch(
                "apps.webhooks.delivery.urllib.request.urlopen",
                side_effect=urllib.error.URLError("connection refused"),
            ):
                attempt_delivery(delivery.pk)
            delivery.refresh_from_db()
            self.assertEqual(delivery.attempts, i)
            self.assertEqual(delivery.status, WebhookDeliveryStatus.PENDING)
            expected = before + timedelta(seconds=backoff)
            self.assertAlmostEqual(
                delivery.next_attempt_at.timestamp(),
                expected.timestamp(),
                delta=5,
            )
            # Force it due again for the next loop iteration.
            WebhookDelivery.objects.filter(pk=delivery.pk).update(
                next_attempt_at=timezone.now() - timedelta(seconds=1)
            )

        # Attempt 6 — beyond the schedule — is terminal.
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            attempt_delivery(delivery.pk)
        delivery.refresh_from_db()
        self.assertEqual(delivery.attempts, 6)
        self.assertEqual(delivery.status, WebhookDeliveryStatus.FAILED)
        self.assertIsNone(delivery.next_attempt_at)
        ep.refresh_from_db()
        self.assertEqual(ep.consecutive_failures, 1)
        self.assertTrue(ep.active)  # 1 < threshold

    def test_http_error_records_status_and_body(self):
        ep = _make_endpoint(self.dana)
        delivery = self._pending_delivery(ep)
        err = urllib.error.HTTPError(
            ep.url, 500, "boom", hdrs=None, fp=None
        )
        err.read = mock.MagicMock(return_value=b"server exploded")
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen", side_effect=err
        ):
            attempt_delivery(delivery.pk)
        delivery.refresh_from_db()
        self.assertEqual(delivery.response_status, 500)
        self.assertEqual(delivery.response_body, "server exploded")
        self.assertEqual(delivery.status, WebhookDeliveryStatus.PENDING)

    def test_success_resets_consecutive_failures(self):
        ep = _make_endpoint(self.dana)
        WebhookEndpoint.objects.filter(pk=ep.pk).update(consecutive_failures=7)
        delivery = self._pending_delivery(ep)
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen",
            return_value=_fake_response(),
        ):
            attempt_delivery(delivery.pk)
        delivery.refresh_from_db()
        ep.refresh_from_db()
        self.assertEqual(delivery.status, WebhookDeliveryStatus.SUCCESS)
        self.assertEqual(delivery.response_status, 200)
        self.assertEqual(ep.consecutive_failures, 0)

    def test_auto_disable_after_threshold(self):
        ep = _make_endpoint(self.dana)
        # 19 prior terminal failures — the next one crosses the threshold (20).
        WebhookEndpoint.objects.filter(pk=ep.pk).update(consecutive_failures=19)
        delivery = self._pending_delivery(ep)
        # Fast-forward to the terminal attempt.
        WebhookDelivery.objects.filter(pk=delivery.pk).update(attempts=5)
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen",
            side_effect=urllib.error.URLError("dead"),
        ):
            attempt_delivery(delivery.pk)
        delivery.refresh_from_db()
        ep.refresh_from_db()
        self.assertEqual(delivery.status, WebhookDeliveryStatus.FAILED)
        self.assertEqual(ep.consecutive_failures, 20)
        self.assertFalse(ep.active)
        self.assertIsNotNone(ep.disabled_at)

    def test_inactive_endpoint_leaves_delivery_pending_untouched(self):
        ep = _make_endpoint(self.dana)
        delivery = self._pending_delivery(ep)
        WebhookEndpoint.objects.filter(pk=ep.pk).update(active=False)
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen"
        ) as urlopen:
            attempt_delivery(delivery.pk)
        urlopen.assert_not_called()
        delivery.refresh_from_db()
        self.assertEqual(delivery.status, WebhookDeliveryStatus.PENDING)
        self.assertEqual(delivery.attempts, 0)

    def test_already_finished_delivery_is_not_resent(self):
        ep = _make_endpoint(self.dana)
        delivery = self._pending_delivery(ep)
        WebhookDelivery.objects.filter(pk=delivery.pk).update(
            status=WebhookDeliveryStatus.SUCCESS
        )
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen"
        ) as urlopen:
            attempt_delivery(delivery.pk)
        urlopen.assert_not_called()


class ProcessDueDeliveriesTests(WebhookTestBase):
    def test_processes_only_due_pending(self):
        ep = _make_endpoint(self.dana)
        due = enqueue_test_delivery(ep)
        future = enqueue_test_delivery(ep)
        WebhookDelivery.objects.filter(pk=due.pk).update(
            next_attempt_at=timezone.now() - timedelta(minutes=1)
        )
        WebhookDelivery.objects.filter(pk=future.pk).update(
            next_attempt_at=timezone.now() + timedelta(hours=1)
        )
        finished = enqueue_test_delivery(ep)
        WebhookDelivery.objects.filter(pk=finished.pk).update(
            status=WebhookDeliveryStatus.SUCCESS,
            next_attempt_at=timezone.now() - timedelta(minutes=5),
        )
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen",
            return_value=_fake_response(),
        ):
            attempted = process_due_deliveries()
        self.assertEqual(attempted, 1)
        due.refresh_from_db()
        future.refresh_from_db()
        self.assertEqual(due.status, WebhookDeliveryStatus.SUCCESS)
        self.assertEqual(future.status, WebhookDeliveryStatus.PENDING)
        self.assertEqual(future.attempts, 0)

    def test_now_override_widens_the_window(self):
        ep = _make_endpoint(self.dana)
        future = enqueue_test_delivery(ep)
        WebhookDelivery.objects.filter(pk=future.pk).update(
            next_attempt_at=timezone.now() + timedelta(hours=1)
        )
        with mock.patch(
            "apps.webhooks.delivery.urllib.request.urlopen",
            return_value=_fake_response(),
        ):
            attempted = process_due_deliveries(now=timezone.now() + timedelta(hours=2))
        self.assertEqual(attempted, 1)


class OnCommitDeferralTests(WebhookTestBase):
    """The first-attempt thread is deferred to ``transaction.on_commit``.

    Task writes from the MCP tools and the recurring generator run inside an
    open transaction; the delivery row is not visible on the daemon thread's
    separate connection until commit, so the attempt must wait for it.
    """

    def test_first_attempt_deferred_until_commit(self):
        _make_endpoint(self.dana)
        with (
            mock.patch("apps.webhooks.dispatch.threading", _inline_threading),
            mock.patch(
                "apps.webhooks.delivery.urllib.request.urlopen",
                return_value=_fake_response(),
            ),
        ):
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                dispatch_task_webhooks(
                    task=self.task,
                    actor=self.chris,
                    verb="assigned",
                    recipients=[self.dana],
                )
                # Inside the (uncommitted) block: the row exists but the
                # attempt has not run — the thread is queued on on_commit.
                d = WebhookDelivery.objects.get()
                self.assertEqual(d.status, WebhookDeliveryStatus.PENDING)
                self.assertEqual(d.attempts, 0)
        # After commit, the on-commit callback fired and delivered.
        self.assertEqual(len(callbacks), 1)
        d.refresh_from_db()
        self.assertEqual(d.status, WebhookDeliveryStatus.SUCCESS)


class ReEnableResetTests(WebhookTestBase):
    """Re-enabling an auto-disabled endpoint clears its failure state."""

    def _client(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_reenable_clears_failure_state(self):
        ep = _make_endpoint(self.chris)
        WebhookEndpoint.objects.filter(pk=ep.pk).update(
            active=False, consecutive_failures=25, disabled_at=timezone.now()
        )
        resp = self._client(self.chris).patch(
            f"/api/webhooks/{ep.pk}/", {"active": True}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        ep.refresh_from_db()
        self.assertTrue(ep.active)
        self.assertEqual(ep.consecutive_failures, 0)
        self.assertIsNone(ep.disabled_at)

    def test_update_while_active_leaves_failures_untouched(self):
        ep = _make_endpoint(self.chris, active=True)
        WebhookEndpoint.objects.filter(pk=ep.pk).update(consecutive_failures=5)
        resp = self._client(self.chris).patch(
            f"/api/webhooks/{ep.pk}/", {"name": "renamed"}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        ep.refresh_from_db()
        self.assertEqual(ep.name, "renamed")
        # Not a re-enable transition — the failure counter is preserved.
        self.assertEqual(ep.consecutive_failures, 5)


class NotificationsHookTests(WebhookTestBase):
    """The dispatch call inside apps.tasks.notifications._notify_task_event."""

    def _notify(self, **kwargs):
        with (
            mock.patch("apps.webhooks.dispatch.threading", _inline_threading),
            mock.patch(
                "apps.webhooks.delivery.urllib.request.urlopen",
                return_value=_fake_response(),
            ),
        ):
            with self.captureOnCommitCallbacks(execute=True):
                notify_task_event(
                    self.task, kwargs.pop("actor"), kwargs.pop("verb"), **kwargs
                )

    def test_hook_fires_for_recipient(self):
        _make_endpoint(self.dana)
        self._notify(actor=self.chris, verb="assigned", recipients=[self.dana])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.event, "assigned")
        self.assertEqual(d.status, WebhookDeliveryStatus.SUCCESS)

    def test_hook_fires_before_empty_recipients_guard(self):
        """Regression: include_self endpoints fire even when the actor is the
        only interested user (unique_recipients ends up empty)."""
        _make_endpoint(self.chris, include_self=True)
        self._notify(actor=self.chris, verb="assigned", recipients=[self.chris])
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.payload["recipient"]["id"], self.chris.id)

    def test_hook_respects_include_self_false(self):
        _make_endpoint(self.chris, include_self=False)
        self._notify(actor=self.chris, verb="assigned", recipients=[self.chris])
        self.assertEqual(WebhookDelivery.objects.count(), 0)

    def test_payload_passthrough(self):
        _make_endpoint(self.dana)
        self._notify(
            actor=self.chris,
            verb="moved",
            recipients=[self.dana],
            payload={"from_column": "Todo", "to_column": "Done"},
        )
        d = WebhookDelivery.objects.get()
        self.assertEqual(d.payload["data"]["to_column"], "Done")


class TestDeliveryHelperTests(WebhookTestBase):
    def test_enqueue_test_delivery_shape(self):
        ep = _make_endpoint(self.chris)
        d = enqueue_test_delivery(ep)
        self.assertEqual(d.event, "webhook.test")
        self.assertEqual(d.status, WebhookDeliveryStatus.PENDING)
        self.assertIsNone(d.task)
        self.assertIsNone(d.payload["task"])
        self.assertEqual(d.payload["recipient"]["id"], self.chris.id)
        self.assertEqual(d.payload["recipients"], [])


class WebhookEndpointSerializerTests(WebhookTestBase):
    def _data(self, **overrides):
        data = dict(
            name="test",
            url="https://example.com/hook",
            event_types=[],
            include_self=False,
        )
        data.update(overrides)
        return data

    def test_accepts_scope_mine(self):
        s = WebhookEndpointSerializer(data=self._data(scope="mine"))
        self.assertTrue(s.is_valid(), s.errors)
        self.assertEqual(s.validated_data["scope"], "mine")

    def test_accepts_scope_all(self):
        s = WebhookEndpointSerializer(data=self._data(scope="all"))
        self.assertTrue(s.is_valid(), s.errors)
        self.assertEqual(s.validated_data["scope"], "all")

    def test_scope_defaults_to_mine_when_omitted(self):
        s = WebhookEndpointSerializer(data=self._data())
        self.assertTrue(s.is_valid(), s.errors)
        ep = s.save(user=self.chris, secret="a" * 64)
        self.assertEqual(ep.scope, WebhookScope.MINE)

    def test_rejects_bad_scope_value(self):
        s = WebhookEndpointSerializer(data=self._data(scope="everyone"))
        self.assertFalse(s.is_valid())
        self.assertIn("scope", s.errors)

    def test_accepts_created_in_event_types(self):
        s = WebhookEndpointSerializer(data=self._data(event_types=["created", "moved"]))
        self.assertTrue(s.is_valid(), s.errors)

    def test_rejects_unknown_event_type(self):
        s = WebhookEndpointSerializer(data=self._data(event_types=["bogus"]))
        self.assertFalse(s.is_valid())
        self.assertIn("event_types", s.errors)
