"""Task comments over REST and MCP.

    uv run python manage.py test apps.tasks.test_comments
"""

from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied
from django.test import TestCase

from apps.mcp_server import tools

from .models import Notification, Project, Task

User = get_user_model()


class TaskCommentTests(TestCase):
    def setUp(self):
        self.ali = User.objects.create_user("ali", password="x", is_staff=True)
        self.chris = User.objects.create_user("chris", password="x", is_staff=True)
        self.emp = User.objects.create_user("emp", password="x")
        self.project = Project.objects.create(name="Cyt", prefix="CYT")
        self.task = Task.objects.create(project=self.project, title="t", reporter=self.ali)
        self.url = f"/api/tasks/{self.task.key}/comments/"
        self.client.force_login(self.ali)

    def _post(self, body, client=None):
        return (client or self.client).post(
            self.url, {"body": body}, content_type="application/json"
        )

    def test_create_and_list_oldest_first(self):
        first = self._post("first").json()
        self._post("second")
        self.assertEqual(first["author"]["username"], "ali")
        self.assertIsNone(first["edited_at"])
        bodies = [c["body"] for c in self.client.get(self.url).json()]
        self.assertEqual(bodies, ["first", "second"])

    def test_blank_body_is_refused(self):
        self.assertEqual(self._post("   ").status_code, 400)

    def test_only_the_author_can_edit_or_delete(self):
        cid = self._post("mine").json()["id"]
        self.client.force_login(self.chris)
        detail = f"{self.url}{cid}/"
        resp = self.client.patch(detail, {"body": "hijack"}, content_type="application/json")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(self.client.delete(detail).status_code, 403)

        self.client.force_login(self.ali)
        resp = self.client.patch(detail, {"body": "edited"}, content_type="application/json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["body"], "edited")
        self.assertIsNotNone(resp.json()["edited_at"])
        self.assertEqual(self.client.delete(detail).status_code, 204)
        self.assertEqual(self.client.get(self.url).json(), [])

    def test_non_staff_cannot_reach_comments(self):
        self.client.force_login(self.emp)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_mention_notifies_valid_staff_users_only(self):
        self._post("hey @Chris, and @emp @ghost and @ali. mail chris@x.com")
        notes = Notification.objects.filter(verb="mentioned")
        # emp is non-staff (can't open tasks), ghost doesn't exist, ali is the author.
        self.assertEqual([n.recipient.username for n in notes], ["chris"])
        self.assertIn("comment_id", notes[0].payload)

    def test_assignees_get_commented_unless_mentioned(self):
        self.task.assignees.add(self.chris)
        self._post("no mention")
        self.assertEqual(Notification.objects.get().verb, "commented")
        Notification.objects.all().delete()
        self._post("@chris look")
        self.assertEqual(list(Notification.objects.values_list("verb", flat=True)), ["mentioned"])

    def test_edit_notifies_only_new_mentions(self):
        cid = self._post("@chris first").json()["id"]
        self.client.patch(
            f"{self.url}{cid}/", {"body": "@chris first, fixed"}, content_type="application/json"
        )
        self.assertEqual(Notification.objects.filter(verb="mentioned").count(), 1)

    def test_comment_count_on_task_list(self):
        self._post("a")
        self._post("b")
        tasks = self.client.get("/api/tasks/", {"project": self.project.id}).json()["results"]
        self.assertEqual(tasks[0]["comment_count"], 2)
        self.assertEqual(self.client.get(f"/api/tasks/{self.task.key}/").json()["comment_count"], 2)

    def test_writes_broadcast(self):
        with mock.patch("apps.tasks.comments.broadcast_task_event") as bc:
            self._post("x")
        bc.assert_called_once()
        self.assertEqual(bc.call_args.args[1], "task.commented")

    def test_mcp_tools(self):
        added = tools.add_comment(self.task.key, "via bot @chris", mcp_user=self.ali)
        self.assertEqual(added["author"], "ali")
        self.assertEqual(Notification.objects.filter(verb="mentioned").count(), 1)
        self.assertEqual(tools.list_comments(self.task.key, mcp_user=self.ali)[0]["body"], "via bot @chris")
        self.assertEqual(tools.get_task(self.task.key, mcp_user=self.ali)["comment_count"], 1)

        with self.assertRaises(PermissionDenied):
            tools.edit_comment(added["id"], "nope", mcp_user=self.chris)
        edited = tools.edit_comment(added["id"], "fixed", mcp_user=self.ali)
        self.assertIsNotNone(edited["edited_at"])
        with self.assertRaises(PermissionDenied):
            tools.delete_comment(added["id"], mcp_user=self.chris)
        tools.delete_comment(added["id"], mcp_user=self.ali)
        self.assertEqual(tools.list_comments(self.task.key, mcp_user=self.ali), [])
