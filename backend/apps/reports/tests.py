from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.tasks.models import Project

from . import services
from .models import pk_from_key


class ReportAccessTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.staff = User.objects.create_user("boss", is_staff=True)
        self.employee = User.objects.create_user("emp")
        mine = Project.objects.create(name="Mowafeq", prefix="MOW")
        other = Project.objects.create(name="Other", prefix="OTH")
        mine.members.add(self.employee)
        self.visible = services.publish_report(title="Mine", summary="", html="<p>a</p>", project="MOW")
        services.publish_report(title="Theirs", summary="", html="<p>b</p>", project=other.id)
        services.publish_report(title="Unfiled", summary="", html="<p>c</p>")

    def client_for(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def test_employee_sees_only_member_projects(self):
        client = self.client_for(self.employee)
        titles = [r["title"] for r in client.get("/api/reports/").json()["results"]]
        self.assertEqual(titles, ["Mine"])
        self.assertNotIn("html", client.get("/api/reports/").json()["results"][0])
        self.assertEqual(client.get(f"/api/reports/{self.visible.key}/").json()["html"], "<p>a</p>")
        self.assertEqual(client.delete(f"/api/reports/{self.visible.key}/").status_code, 403)
        hidden = services.visible_reports(None).get(title="Unfiled")
        self.assertEqual(client.get(f"/api/reports/{hidden.key}/").status_code, 404)

    def test_staff_sees_everything_and_searches(self):
        client = self.client_for(self.staff)
        self.assertEqual(client.get("/api/reports/").json()["count"], 3)
        self.assertEqual(client.get("/api/reports/?q=unfil").json()["count"], 1)

    def test_publish_validates(self):
        with self.assertRaises(services.ReportError):
            services.publish_report(title="Big", summary="", html="x" * (services.MAX_HTML_BYTES + 1))
        with self.assertRaises(services.ReportError):
            services.publish_report(title="Bad", summary="", html="<p/>", project="NOPE")
        self.assertEqual(pk_from_key("rpt-042"), 42)
        self.assertIsNone(pk_from_key("MTG-1"))
