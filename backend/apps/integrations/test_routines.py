from unittest.mock import patch

from asgiref.sync import async_to_sync
from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.test import APIClient

from .models import Routine, RoutineRun
from .routines import delete_routine, list_routines, match_runs, record_finished_runs, save_routine


class RoutineTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("routine-agent")
        self.fields = {"name": "Documentation sync", "instructions": "Check docs.", "trigger_type": "schedule", "trigger_description": "Every Saturday at 00:00 UTC", "enabled": True, "skills": ["sync-mowafeq-documentation"]}
        self.external_id = "cron:job-123"
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def create(self):
        return save_routine(self.external_id, self.fields, create=True, mcp_user=self.user)

    @patch("apps.integrations.routines.broadcast_task_event")
    def test_idempotent_create_partial_update_clear_and_broadcast(self, broadcast):
        with self.captureOnCommitCallbacks(execute=True):
            first = self.create()
            second = self.create()
            updated = save_routine(self.external_id, {"enabled": False, "next_run_at": "2026-10-01T00:00:00Z"}, mcp_user=self.user)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(Routine.objects.count(), 1)
        self.assertFalse(updated["enabled"])
        self.assertIsNone(updated["next_run_at"])
        self.assertEqual(updated["instructions"], "Check docs.")
        self.assertEqual(Routine.objects.get().updated_by, self.user)
        self.assertEqual(broadcast.call_count, 3)
        self.assertEqual(list_routines()["count"], 1)

    def test_validation_preserves_record(self):
        self.create()
        for fields in [{"trigger_type": "invalid"}, {"name": ""}, {"skills": "wrong"}, {"secret": "not-stored"}, {"external_id": "cron:other"}, {"next_run_at": "not-a-date"}, {"trigger_type": "webhook"}]:
            with self.assertRaises(ValidationError):
                save_routine(self.external_id, fields)
        self.assertEqual(Routine.objects.get().name, self.fields["name"])
        with self.assertRaises(NotFound):
            save_routine("cron:missing", {"enabled": False})
        with self.assertRaises(ValueError):
            list_routines(limit=10000)

    def test_runs_pair_sessions_with_saved_outcomes(self):
        record_finished_runs([{"id": "abc", "last_run_at": "2026-10-20T00:00:22+00:00", "last_status": "error", "last_error": "boom"}])
        record_finished_runs([{"id": "abc", "last_run_at": "2026-10-20T00:00:22+00:00", "last_status": "ok"}])  # same run seen twice
        record_finished_runs([{"id": "abc", "last_run_at": "2026-10-21T00:00:22+00:00", "last_status": "ok"}])
        day = 1792454400  # 2026-10-20T00:00:00Z
        sessions = [
            {"id": "cron_abc_20261020_000010", "started_at": day + 10, "ended_at": day + 21},
            {"id": "cron_abc_20261021_000010", "started_at": day + 86410, "ended_at": day + 86421},
            {"id": "cron_abc_20261022_000010", "started_at": day + 172810, "ended_at": None},
        ]
        runs = match_runs(sessions, RoutineRun.objects.filter(job_id="abc"))
        self.assertEqual([(r["session_id"][-15:-7], r["status"], r["error"]) for r in runs], [("20261022", "running", ""), ("20261021", "ok", ""), ("20261020", "error", "boom")])

    @patch("apps.integrations.routines.hermes")
    def test_http_routines_are_authenticated_and_recap_only_reads_cron_runs(self, hermes):
        hermes.return_value = {"data": [{"role": "assistant", "content": "Draft"}, {"role": "tool", "content": "x"}, {"role": "assistant", "content": "Nothing to organize."}]}
        response = self.client.get("/api/integrations/routines/abc/runs/cron_abc_20261021_000010/")
        self.assertEqual(response.data["recap"], "Nothing to organize.")
        self.assertEqual(self.client.get("/api/integrations/routines/abc/runs/telegram_123/").status_code, 404)
        self.assertEqual(self.client.get("/api/integrations/routines/abc/runs/cron_other_20261021_000010/").status_code, 404)
        self.assertEqual(hermes.call_count, 1)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/integrations/routines/").status_code, 403)

    def test_delete_retry_and_mcp_registration(self):
        self.create()
        self.assertTrue(delete_routine(self.external_id, mcp_user=self.user)["deleted"])
        self.assertFalse(delete_routine(self.external_id, mcp_user=self.user)["deleted"])
        from apps.mcp_server.server import READ_ONLY_TOOLS, mcp
        tools = {tool.name for tool in async_to_sync(mcp.list_tools)()}
        self.assertTrue({"list_routines", "get_routine", "create_routine", "update_routine", "delete_routine"} <= tools)
        self.assertTrue({"list_routines", "get_routine"} <= READ_ONLY_TOOLS)
        self.assertFalse({"create_routine", "update_routine", "delete_routine"} & READ_ONLY_TOOLS)
