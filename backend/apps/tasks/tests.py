"""Tests for column ``kind`` and the throughput analytics.

Self-contained (see ``apps/webhooks/tests.py`` for the house style). Run with:

    uv run python manage.py test apps.tasks

Django builds its own test database, so nothing here touches the real
``db.sqlite3``.
"""

from __future__ import annotations

import importlib
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.mcp_server import tools as mcp_tools

from .analytics import throughput
from .models import Column, ColumnKind, Project, Task
from .transitions import record_transition

User = get_user_model()

UTC = ZoneInfo("UTC")


def _dt(y, m, d, hh=12, mm=0, tz=UTC):
    return datetime(y, m, d, hh, mm, tzinfo=tz)


class ColumnKindMirrorTests(TestCase):
    """``is_done`` is a derived mirror of ``kind`` — kept in lockstep on save."""

    def setUp(self):
        self.project = Project.objects.create(name="Cyt", prefix="CYT")

    def test_default_columns_seeded_with_kinds(self):
        kinds = {c.name: c.kind for c in self.project.columns.all()}
        self.assertEqual(
            kinds,
            {
                "Backlog": ColumnKind.BACKLOG,
                "Todo": ColumnKind.TODO,
                "In Progress": ColumnKind.IN_PROGRESS,
                "In Review": ColumnKind.REVIEW,
                "Done": ColumnKind.DONE,
            },
        )

    def test_seeded_done_column_is_done_true(self):
        done = self.project.columns.get(name="Done")
        self.assertTrue(done.is_done)
        self.assertEqual(
            list(
                self.project.columns.filter(is_done=True).values_list("name", flat=True)
            ),
            ["Done"],
        )

    def test_save_sets_is_done_from_kind(self):
        col = Column.objects.create(
            project=self.project, name="Shipped", order=99, kind=ColumnKind.DONE
        )
        self.assertTrue(col.is_done)

    def test_save_clears_is_done_when_kind_not_done(self):
        col = self.project.columns.get(name="Done")
        col.kind = ColumnKind.TODO
        col.save()
        col.refresh_from_db()
        self.assertFalse(col.is_done)

    def test_is_done_cannot_be_forced_against_kind(self):
        # Passing is_done=True with a non-done kind is overridden on save.
        col = Column.objects.create(
            project=self.project,
            name="Wishful",
            order=98,
            kind=ColumnKind.TODO,
            is_done=True,
        )
        self.assertFalse(col.is_done)


class ColumnKindBackfillMigrationTests(TestCase):
    """The 0023 data migration classifies pre-existing columns."""

    def setUp(self):
        self.project = Project.objects.create(name="Cyt", prefix="CYT")
        self._backfill = importlib.import_module(
            "apps.tasks.migrations.0023_column_kind"
        ).backfill_kind

    def _simulate_pre_migration(self):
        # Reset every seeded column to the "other" default via .update() so we
        # bypass Column.save() (which would re-derive kind/is_done) and land in
        # the exact state the AddField default leaves rows in.
        Column.objects.filter(project=self.project).update(kind=ColumnKind.OTHER)

    def test_backfill_matches_names_and_done_flag(self):
        self._simulate_pre_migration()
        # A renamed done column: is_done stays True, name is non-standard.
        Column.objects.filter(project=self.project, name="Done").update(
            name="Shipped"
        )
        self._backfill(django_apps, None)
        by_name = {c.name: c.kind for c in self.project.columns.all()}
        self.assertEqual(by_name["Backlog"], ColumnKind.BACKLOG)
        self.assertEqual(by_name["Todo"], ColumnKind.TODO)
        self.assertEqual(by_name["In Progress"], ColumnKind.IN_PROGRESS)
        self.assertEqual(by_name["In Review"], ColumnKind.REVIEW)
        # is_done=True wins over the (unrecognized) name.
        self.assertEqual(by_name["Shipped"], ColumnKind.DONE)

    def test_backfill_leaves_unknown_columns_as_other(self):
        self._simulate_pre_migration()
        Column.objects.create(
            project=self.project, name="Parking Lot", order=50, kind=ColumnKind.OTHER
        )
        Column.objects.filter(project=self.project, name="Parking Lot").update(
            kind=ColumnKind.OTHER, is_done=False
        )
        self._backfill(django_apps, None)
        col = self.project.columns.get(name="Parking Lot")
        self.assertEqual(col.kind, ColumnKind.OTHER)

    def test_backfill_name_match_is_case_insensitive(self):
        self._simulate_pre_migration()
        Column.objects.filter(project=self.project, name="In Progress").update(
            name="IN PROGRESS"
        )
        self._backfill(django_apps, None)
        col = self.project.columns.get(name="IN PROGRESS")
        self.assertEqual(col.kind, ColumnKind.IN_PROGRESS)


class ThroughputTestBase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("chris", "chris@example.com", "x")
        self.project = Project.objects.create(name="Cyt", prefix="CYT")
        cols = {c.kind: c for c in self.project.columns.all()}
        self.backlog = cols[ColumnKind.BACKLOG]
        self.in_progress = cols[ColumnKind.IN_PROGRESS]
        self.review = cols[ColumnKind.REVIEW]
        self.done = cols[ColumnKind.DONE]

    def _task(self, title="t"):
        return Task.objects.create(
            project=self.project,
            column=self.backlog,
            title=title,
            reporter=self.user,
        )

    def _created(self, task, at):
        record_transition(task, from_column=None, to_column=self.backlog, at=at)

    def _enter(self, task, column, at, frm=None):
        record_transition(task, from_column=frm, to_column=column, at=at)

    def _row(self, days, iso):
        return next(r for r in days if r["date"] == iso)


class ThroughputBucketingTests(ThroughputTestBase):
    def test_created_bucketed_by_day(self):
        t1, t2, t3 = self._task(), self._task(), self._task()
        self._created(t1, _dt(2026, 7, 1, 9))
        self._created(t2, _dt(2026, 7, 1, 23))
        self._created(t3, _dt(2026, 7, 2, 1))
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 3), UTC)
        self.assertEqual(self._row(days, "2026-07-01")["created"], 2)
        self.assertEqual(self._row(days, "2026-07-02")["created"], 1)
        self.assertEqual(self._row(days, "2026-07-03")["created"], 0)

    def test_stage_series_land_on_the_right_day(self):
        t = self._task()
        self._enter(t, self.in_progress, _dt(2026, 7, 1, 10))
        self._enter(t, self.review, _dt(2026, 7, 2, 10))
        self._enter(t, self.done, _dt(2026, 7, 3, 10))
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 3), UTC)
        self.assertEqual(self._row(days, "2026-07-01")["started"], 1)
        self.assertEqual(self._row(days, "2026-07-02")["in_review"], 1)
        self.assertEqual(self._row(days, "2026-07-03")["completed"], 1)

    def test_zero_fill_every_day_ascending(self):
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 5), UTC)
        self.assertEqual(
            [r["date"] for r in days],
            ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"],
        )
        for r in days:
            self.assertEqual(
                (r["created"], r["started"], r["in_review"], r["completed"]),
                (0, 0, 0, 0),
            )


class ThroughputDistinctTests(ThroughputTestBase):
    def test_same_stage_twice_in_a_day_counts_once(self):
        t = self._task()
        self._enter(t, self.in_progress, _dt(2026, 7, 1, 9))
        self._enter(t, self.in_progress, _dt(2026, 7, 1, 15))
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 1), UTC)
        self.assertEqual(self._row(days, "2026-07-01")["started"], 1)

    def test_two_distinct_tasks_same_day_count_two(self):
        a, b = self._task(), self._task()
        self._enter(a, self.done, _dt(2026, 7, 1, 9))
        self._enter(b, self.done, _dt(2026, 7, 1, 10))
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 1), UTC)
        self.assertEqual(self._row(days, "2026-07-01")["completed"], 2)

    def test_completed_uses_is_done_mirror(self):
        # A column renamed but still kind=done is counted as completed.
        self.done.name = "Shipped"
        self.done.save()
        t = self._task()
        self._enter(t, self.done, _dt(2026, 7, 1, 9))
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 1), UTC)
        self.assertEqual(self._row(days, "2026-07-01")["completed"], 1)


class ThroughputTimezoneTests(ThroughputTestBase):
    def test_evening_utc_event_lands_next_day_in_positive_offset(self):
        t = self._task()
        # 22:00 UTC on the 1st is 01:00 on the 2nd in UTC+3 (Asia/Baghdad).
        self._enter(t, self.done, _dt(2026, 7, 1, 22))
        baghdad = ZoneInfo("Asia/Baghdad")
        days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 2), baghdad)
        self.assertEqual(self._row(days, "2026-07-01")["completed"], 0)
        self.assertEqual(self._row(days, "2026-07-02")["completed"], 1)
        # Same event, viewed from UTC, stays on the 1st.
        utc_days = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 2), UTC)
        self.assertEqual(self._row(utc_days, "2026-07-01")["completed"], 1)


class ThroughputProjectFilterTests(ThroughputTestBase):
    def test_project_filter_excludes_other_projects(self):
        other = Project.objects.create(name="Other", prefix="OTH")
        other_done = other.columns.get(kind=ColumnKind.DONE)
        other_task = Task.objects.create(
            project=other, column=other_done, title="x", reporter=self.user
        )
        self._enter(other_task, other_done, _dt(2026, 7, 1, 9))
        mine = self._task()
        self._enter(mine, self.done, _dt(2026, 7, 1, 9))

        scoped = throughput(self.project.id, date(2026, 7, 1), date(2026, 7, 1), UTC)
        self.assertEqual(self._row(scoped, "2026-07-01")["completed"], 1)

        all_projects = throughput(None, date(2026, 7, 1), date(2026, 7, 1), UTC)
        self.assertEqual(self._row(all_projects, "2026-07-01")["completed"], 2)


class ThroughputAPITests(ThroughputTestBase):
    def _client(self):
        client = APIClient()
        client.force_authenticate(user=self.user)
        return client

    def test_requires_authentication(self):
        resp = APIClient().get("/api/analytics/throughput/")
        self.assertEqual(resp.status_code, 403)

    def test_default_window_is_30_days(self):
        resp = self._client().get("/api/analytics/throughput/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["days"]), 30)

    def test_explicit_range_zero_filled_and_shaped(self):
        resp = self._client().get(
            "/api/analytics/throughput/",
            {"from": "2026-07-01", "to": "2026-07-03", "tz": "UTC"},
        )
        self.assertEqual(resp.status_code, 200)
        days = resp.data["days"]
        self.assertEqual(
            [r["date"] for r in days],
            ["2026-07-01", "2026-07-02", "2026-07-03"],
        )
        self.assertEqual(
            set(days[0].keys()),
            {"date", "created", "started", "in_review", "completed"},
        )

    def test_range_cap_returns_400(self):
        resp = self._client().get(
            "/api/analytics/throughput/",
            {"from": "2025-01-01", "to": "2026-06-01"},  # > 366 days
        )
        self.assertEqual(resp.status_code, 400)

    def test_exactly_366_days_ok(self):
        start = date(2026, 1, 1)
        end = start + timedelta(days=365)  # 366 inclusive
        resp = self._client().get(
            "/api/analytics/throughput/",
            {"from": start.isoformat(), "to": end.isoformat()},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["days"]), 366)

    def test_unknown_tz_returns_400(self):
        resp = self._client().get("/api/analytics/throughput/", {"tz": "Mars/Phobos"})
        self.assertEqual(resp.status_code, 400)

    def test_invalid_date_returns_400(self):
        resp = self._client().get("/api/analytics/throughput/", {"from": "not-a-date"})
        self.assertEqual(resp.status_code, 400)

    def test_unknown_project_returns_400(self):
        resp = self._client().get("/api/analytics/throughput/", {"project": "999999"})
        self.assertEqual(resp.status_code, 400)

    def test_non_integer_project_returns_400(self):
        resp = self._client().get("/api/analytics/throughput/", {"project": "abc"})
        self.assertEqual(resp.status_code, 400)

    def test_from_after_to_returns_400(self):
        resp = self._client().get(
            "/api/analytics/throughput/",
            {"from": "2026-07-05", "to": "2026-07-01"},
        )
        self.assertEqual(resp.status_code, 400)


class ThroughputMcpParityTests(ThroughputTestBase):
    """The MCP helper returns the same numbers as the DRF view."""

    def _client(self):
        client = APIClient()
        client.force_authenticate(user=self.user)
        return client

    def test_mcp_matches_view_default_window(self):
        # Two events in the current 30-day window, dated now / yesterday (UTC).
        now = timezone.now()
        a, b = self._task(), self._task()
        self._enter(a, self.done, now - timedelta(hours=1))
        self._enter(b, self.in_progress, now - timedelta(days=1))

        resp = self._client().get("/api/analytics/throughput/", {"tz": "UTC"})
        view_days = resp.data["days"]
        mcp_days = mcp_tools.get_throughput(project=None, days=30, tz="UTC")
        self.assertEqual(mcp_days, view_days)

    def test_mcp_project_by_prefix_matches_view(self):
        now = timezone.now()
        t = self._task()
        self._enter(t, self.done, now - timedelta(hours=1))
        resp = self._client().get(
            "/api/analytics/throughput/",
            {"project": str(self.project.id), "tz": "UTC"},
        )
        mcp_days = mcp_tools.get_throughput(project="CYT", days=30, tz="UTC")
        self.assertEqual(mcp_days, resp.data["days"])

    def test_mcp_unknown_tz_raises(self):
        with self.assertRaises(ValueError):
            mcp_tools.get_throughput(tz="Mars/Phobos")


class ColumnKindApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("chris", "chris@example.com", "x")
        self.project = Project.objects.create(name="Cyt", prefix="CYT")

    def _client(self):
        client = APIClient()
        client.force_authenticate(user=self.user)
        return client

    def test_create_column_accepts_kind(self):
        resp = self._client().post(
            "/api/columns/",
            {"project": self.project.id, "name": "QA", "kind": "review"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(resp.data["kind"], "review")
        self.assertFalse(resp.data["is_done"])

    def test_create_column_kind_done_sets_is_done(self):
        resp = self._client().post(
            "/api/columns/",
            {"project": self.project.id, "name": "Shipped", "kind": "done"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertTrue(resp.data["is_done"])

    def test_create_column_rejects_bad_kind(self):
        resp = self._client().post(
            "/api/columns/",
            {"project": self.project.id, "name": "Nope", "kind": "bogus"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("kind", resp.data)

    def test_update_column_changes_kind(self):
        col = self.project.columns.get(name="Backlog")
        resp = self._client().patch(
            f"/api/columns/{col.id}/", {"kind": "in_progress"}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["kind"], "in_progress")

    def test_is_done_is_read_only_via_api(self):
        col = self.project.columns.get(name="Backlog")
        resp = self._client().patch(
            f"/api/columns/{col.id}/", {"is_done": True}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        # Ignored — kind unchanged, so still not done.
        self.assertFalse(resp.data["is_done"])

    def test_cannot_demote_last_done_column(self):
        done = self.project.columns.get(name="Done")
        resp = self._client().patch(
            f"/api/columns/{done.id}/", {"kind": "todo"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)


class ColumnKindMcpTests(TestCase):
    def setUp(self):
        self.project = Project.objects.create(name="Cyt", prefix="CYT")

    def test_mcp_create_column_with_kind(self):
        out = mcp_tools.create_column(project=self.project.id, name="QA", kind="review")
        self.assertEqual(out["kind"], "review")
        self.assertFalse(out["is_done"])

    def test_mcp_create_column_legacy_is_done(self):
        out = mcp_tools.create_column(
            project=self.project.id, name="Shipped", is_done=True
        )
        self.assertEqual(out["kind"], "done")
        self.assertTrue(out["is_done"])

    def test_mcp_create_column_bad_kind_raises(self):
        with self.assertRaises(ValueError):
            mcp_tools.create_column(project=self.project.id, name="X", kind="bogus")

    def test_mcp_update_column_kind(self):
        col = self.project.columns.get(name="Backlog")
        out = mcp_tools.update_column(column_id=col.id, kind="done")
        self.assertEqual(out["kind"], "done")
        self.assertTrue(out["is_done"])

    def test_mcp_update_column_refuses_last_done_demotion(self):
        done = self.project.columns.get(name="Done")
        with self.assertRaises(ValueError):
            mcp_tools.update_column(column_id=done.id, kind="todo")
