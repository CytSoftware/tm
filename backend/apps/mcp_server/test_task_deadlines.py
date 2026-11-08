"""Task deadlines (``due_at``) over MCP.

Before this, ``create_task``/``update_task`` had no ``due_at`` and FastMCP
dropped the unknown argument, so "set the deadline" returned ok and did
nothing. These pin the argument, its formats, and the unknown-argument guard.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from asgiref.sync import async_to_sync
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tasks.models import Project, Task

from . import tools
from .auth import SCOPE_SCOPES_KEY, SCOPE_USER_KEY
from .tests import fake_request_ctx, reset_request_ctx

User = get_user_model()
QATAR = ZoneInfo("Asia/Qatar")


class TaskDeadlineToolTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("boss", is_staff=True)
        self.project = Project.objects.create(name="Cyt", prefix="CYT")

    def _create(self, **kw):
        return tools.create_task(project="CYT", title="Ship it", mcp_user=self.user, **kw)

    def _due(self, key):
        return Task.objects.get(key=key).due_at

    def test_create_with_an_iso_datetime(self):
        key = self._create(due_at="2026-11-20T17:00:00+03:00")["key"]
        self.assertEqual(self._due(key), datetime(2026, 11, 20, 14, 0, tzinfo=ZoneInfo("UTC")))

    def test_create_without_due_at_leaves_it_empty(self):
        result = self._create()
        self.assertIsNone(result["due_at"])
        self.assertIsNone(self._due(result["key"]))

    def test_a_date_means_the_end_of_that_day_in_company_time(self):
        key = self._create(due_at="2026-11-20")["key"]
        self.assertEqual(self._due(key), datetime(2026, 11, 20, 23, 59, 59, tzinfo=QATAR))

    def test_a_naive_datetime_is_company_time(self):
        key = self._create(due_at="2026-11-20T09:30")["key"]
        self.assertEqual(self._due(key), datetime(2026, 11, 20, 9, 30, tzinfo=QATAR))

    def test_utc_z_suffix(self):
        key = self._create(due_at="2026-11-20T12:00:00Z")["key"]
        self.assertEqual(self._due(key), datetime(2026, 11, 20, 12, 0, tzinfo=ZoneInfo("UTC")))

    def test_update_sets_changes_and_clears(self):
        key = self._create()["key"]

        tools.update_task(key, due_at="2026-11-20", mcp_user=self.user)
        self.assertEqual(self._due(key), datetime(2026, 11, 20, 23, 59, 59, tzinfo=QATAR))

        result = tools.update_task(key, due_at="2026-12-01T10:00:00+00:00", mcp_user=self.user)
        self.assertEqual(self._due(key), datetime(2026, 12, 1, 10, 0, tzinfo=ZoneInfo("UTC")))
        self.assertEqual(datetime.fromisoformat(result["due_at"]), self._due(key))

        # Omitting it leaves it alone…
        tools.update_task(key, title="Renamed", mcp_user=self.user)
        self.assertIsNotNone(self._due(key))
        # …and "none" clears it.
        self.assertIsNone(tools.update_task(key, due_at="none", mcp_user=self.user)["due_at"])
        self.assertIsNone(self._due(key))

    def test_invalid_values_are_refused_with_the_accepted_formats(self):
        key = self._create(due_at="2026-11-20")["key"]
        for bad in ("next friday", "2026-13-01", "2026-02-30", "", 20261120):
            with self.subTest(bad=bad):
                with self.assertRaisesMessage(ValueError, "ISO-8601"):
                    tools.update_task(key, due_at=bad, mcp_user=self.user)
                with self.assertRaisesMessage(ValueError, "ISO-8601"):
                    self._create(due_at=bad)
        # A refused update changed nothing.
        self.assertEqual(self._due(key), datetime(2026, 11, 20, 23, 59, 59, tzinfo=QATAR))
        self.assertEqual(Task.objects.count(), 1)

    def test_list_filters_due_before_and_overdue(self):
        now = timezone.now()
        late = self._create(due_at=(now - timedelta(days=2)).isoformat())["key"]
        soon = self._create(due_at=(now + timedelta(days=1)).isoformat())["key"]
        later = self._create(due_at=(now + timedelta(days=30)).isoformat())["key"]
        undated = self._create()["key"]
        done_late = self._create(
            due_at=(now - timedelta(days=5)).isoformat(),
            column=self.project.columns.get(is_done=True).id,
        )["key"]

        def keys(**kw):
            return {t["key"] for t in tools.list_tasks(project="CYT", mcp_user=self.user, **kw)}

        cutoff = (now + timedelta(days=7)).date().isoformat()
        self.assertEqual(keys(due_before=cutoff), {late, soon, done_late})
        self.assertEqual(keys(overdue=True), {late})
        self.assertEqual(keys(overdue=False), {soon, later, undated, done_late})
        with self.assertRaisesMessage(ValueError, "ISO-8601"):
            keys(due_before="soon")

    def test_date_only_due_before_includes_the_whole_day(self):
        key = self._create(due_at="2026-11-20T23:30:00+03:00")["key"]
        found = tools.list_tasks(due_before="2026-11-20", mcp_user=self.user)
        self.assertEqual([t["key"] for t in found], [key])
        self.assertEqual(tools.list_tasks(due_before="2026-11-19", mcp_user=self.user), [])


class McpEntryPointDeadlineTests(TestCase):
    """Through ``mcp.call_tool`` — the path a real client takes."""

    def setUp(self):
        self.user = User.objects.create_user("boss", is_staff=True)
        Project.objects.create(name="Cyt", prefix="CYT")
        self._ctx = fake_request_ctx({SCOPE_USER_KEY: self.user, SCOPE_SCOPES_KEY: ["read", "write"]})

    def tearDown(self):
        reset_request_ctx(self._ctx)

    def _call(self, name, **arguments):
        from .server import mcp

        return async_to_sync(mcp.call_tool)(name, arguments)

    def test_due_at_round_trips(self):
        self._call("create_task", project="CYT", title="Ship it", due_at="2026-11-20")
        task = Task.objects.get()
        self.assertEqual(task.due_at, datetime(2026, 11, 20, 23, 59, 59, tzinfo=QATAR))
        self._call("update_task", key=task.key, due_at="none")
        task.refresh_from_db()
        self.assertIsNone(task.due_at)

    def test_unknown_arguments_are_refused_not_ignored(self):
        self._call("create_task", project="CYT", title="Ship it")
        key = Task.objects.get().key
        with self.assertRaisesMessage(Exception, "unknown argument(s): deadline"):
            self._call("update_task", key=key, deadline="2026-11-20")
        with self.assertRaisesMessage(Exception, "due_at"):  # names what is accepted
            self._call("update_task", key=key, due_date="2026-11-20")
        self.assertIsNone(Task.objects.get().due_at)
