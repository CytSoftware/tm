from unittest.mock import patch

from asgiref.sync import async_to_sync
from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.test import APIClient

from .models import Routine
from .routines import delete_routine, list_routines, save_routine


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

    def test_http_viewer_is_read_only_and_authenticated(self):
        record = self.create()
        response = self.client.get("/api/integrations/routines/?limit=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["results"][0]["external_id"], self.external_id)
        for method, path in [("post", "/api/integrations/routines/"), ("patch", f"/api/integrations/routines/{record['id']}/"), ("delete", f"/api/integrations/routines/{record['id']}/")]:
            self.assertEqual(getattr(self.client, method)(path, {}, format="json").status_code, 405)
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
