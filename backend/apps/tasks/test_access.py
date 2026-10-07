"""Non-staff access: project membership gates tasks, meetings and wiki;
explicit rows gate Drive and the LLM wiki; every other app is refused.

    uv run python manage.py test apps.tasks.test_access
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.drive.models import DriveFile, KnowledgePageProject
from apps.meetings.models import Meeting
from apps.wiki.models import Doc

from .access import visible_doc_ids, visible_drive_keys, visible_knowledge_slugs
from .models import Project, Task

User = get_user_model()


class NonStaffAccessTests(TestCase):
    def setUp(self):
        self.mine = Project.objects.create(name="Mowafeq", prefix="MOW")
        self.theirs = Project.objects.create(name="Shelter", prefix="SHE")
        self.employee = User.objects.create_user("emp", password="x")
        self.mine.members.add(self.employee)
        self.boss = User.objects.create_user("boss", password="x", is_staff=True)
        # Session login, so NonStaffAccessMiddleware sees the user.
        self.client.force_login(self.employee)

    def test_only_listed_apps_are_reachable(self):
        self.assertEqual(self.client.get("/api/tasks/").status_code, 200)
        self.assertEqual(self.client.get("/api/meetings/").status_code, 200)
        for path in ("/api/bets/", "/api/integrations/routines/", "/api/progress/",
                     "/api/analytics/throughput/", "/api/mcp/tokens/"):
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(self.client.post("/api/columns/", {}).status_code, 403)

    def test_tasks_are_limited_to_member_projects(self):
        Task.objects.create(project=self.mine, title="visible", reporter=self.boss)
        hidden = Task.objects.create(project=self.theirs, title="hidden", reporter=self.boss)
        titles = [t["title"] for t in self.client.get("/api/tasks/").json()["results"]]
        self.assertEqual(titles, ["visible"])
        self.assertEqual(self.client.get(f"/api/tasks/{hidden.key}/").status_code, 404)
        resp = self.client.post(
            "/api/tasks/", {"title": "x", "project_id": self.theirs.id},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            [p["prefix"] for p in self.client.get("/api/projects/").json()["results"]],
            ["MOW"],
        )

    def test_meetings_without_a_member_project_are_hidden(self):
        now = timezone.now()
        Meeting.objects.create(stem="a", title="ours", started_at=now, project=self.mine)
        Meeting.objects.create(stem="b", title="theirs", started_at=now, project=self.theirs)
        unfiled = Meeting.objects.create(stem="c", title="unfiled", started_at=now)
        titles = [m["title"] for m in self.client.get("/api/meetings/").json()["results"]]
        self.assertEqual(titles, ["ours"])
        self.assertEqual(self.client.get(f"/api/meetings/{unfiled.key}/").status_code, 404)

    def test_wiki_pages_inherit_their_ancestors_project(self):
        top = Doc.objects.create(title="top", project=self.mine)
        child = Doc.objects.create(title="child", parent=top)
        other = Doc.objects.create(title="other", project=self.theirs)
        orphan = Doc.objects.create(title="unfiled")
        own = Doc.objects.create(title="own draft", created_by=self.employee)
        self.assertEqual(visible_doc_ids(self.employee), {top.pk, child.pk, own.pk})
        self.assertIsNone(visible_doc_ids(self.boss))
        self.assertNotIn(other.pk, visible_doc_ids(self.employee))
        self.assertNotIn(orphan.pk, visible_doc_ids(self.employee))

    def test_llm_wiki_page_needs_every_project_it_is_filed_under(self):
        KnowledgePageProject.objects.create(slug="projects/mowafeq", project=self.mine)
        KnowledgePageProject.objects.create(slug="entities/egis", project=self.mine)
        KnowledgePageProject.objects.create(slug="entities/egis", project=self.theirs)
        self.assertEqual(visible_knowledge_slugs(self.employee), {"projects/mowafeq"})

    def test_drive_files_are_uploaded_or_shared_only(self):
        DriveFile.objects.create(key="uploads/mine.pdf", uploaded_by=self.employee)
        DriveFile.objects.create(key="finances/invoice.pdf")
        DriveFile.objects.create(key="docs/brief.pdf").shared_with.add(self.employee)
        self.assertEqual(
            visible_drive_keys(self.employee), {"uploads/mine.pdf", "docs/brief.pdf"}
        )
