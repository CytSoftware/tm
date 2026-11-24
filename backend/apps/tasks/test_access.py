"""Access by module × project (``apps.tasks.access``).

A non-staff user sees a row only with the module and — for a project-scoped
module — membership of the row's project. Staff bypass everything.

    uv run python manage.py test apps.tasks.test_access
"""

from __future__ import annotations

import importlib
from datetime import date
from decimal import Decimal
from unittest import mock

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.crm.models import Lead, Payment, Update
from apps.drive.models import DriveFile, KnowledgePageProject
from apps.integrations.models import InfrastructureService
from apps.meetings.models import Entity, EntityKind, Meeting
from apps.reports.models import Report
from apps.wiki.models import Doc

from .access import MODULE_ONLY, MODULES, visible_doc_ids, visible_drive_keys, visible_knowledge_slugs
from .models import Bet, Project, Task, UserProfile
from .periods import current_period_start

User = get_user_model()

#: What a non-staff account reached before modules existed (migration 0036).
LEGACY = ["meetings", "reports", "wiki", "llm_wiki", "drive"]


def grant(user, modules):
    UserProfile.objects.update_or_create(user=user, defaults={"modules": list(modules)})


def rows(response):
    data = response.json()
    return data["results"] if isinstance(data, dict) else data


class ModuleMatrixTests(TestCase):
    """One table: each module's list endpoint × four kinds of user."""

    #: (module, list endpoint, rows the module holder sees in their project /
    #: everywhere). Module-only modules show every project's rows.
    TABLE = (
        ("tasks", "/api/tasks/", 1, 2),
        ("bets", "/api/bets/", 2, 2),
        ("analytics", "/api/analytics/throughput/", None, None),
        ("crm", "/api/crm/leads/", 1, 2),
        ("billing", "/api/crm/payments/", 1, 2),
        ("meetings", "/api/meetings/", 1, 2),
        ("reports", "/api/reports/", 1, 2),
        ("wiki", "/api/wiki-docs/", 1, 2),
        ("operations", "/api/integrations/services/", 1, 1),
    )

    @classmethod
    def setUpTestData(cls):
        cls.mine = Project.objects.create(name="Mowafeq", prefix="MOW")
        cls.theirs = Project.objects.create(name="Shelter", prefix="SHE")
        cls.staff = User.objects.create_user("boss", is_staff=True)
        company = Entity.objects.create(kind=EntityKind.COMPANY, name="ECG", slug="ecg")
        for project in (cls.mine, cls.theirs):
            Task.objects.create(project=project, title="t", reporter=cls.staff)
            Bet.objects.create(project=project, name="b", period_start=current_period_start())
            Lead.objects.create(title="l", project=project)
            Payment.objects.create(
                title="p", company=company, project=project, type="one_off",
                amount=Decimal("10"), due_on=date(2026, 12, 1),
            )
            Meeting.objects.create(
                stem=project.prefix, title="m", started_at=timezone.now(), project=project
            )
            Report.objects.create(title="r", html="<p>r</p>", project=project)
            Doc.objects.create(title="d", project=project)
        InfrastructureService.objects.create(name="s", url="https://s.example", category="x")

    def user(self, name, *, modules, member):
        user = User.objects.create_user(name)
        grant(user, modules)
        if member:
            self.mine.members.add(user)
        return user

    def test_list_endpoints(self):
        for module, path, in_mine, everywhere in self.TABLE:
            others = [m for m in MODULES if m != module]
            cases = (
                ("staff", self.staff, 200, everywhere),
                ("member with module", self.user(f"a-{module}", modules=[module], member=True),
                 200, in_mine),
                ("member without module", self.user(f"b-{module}", modules=others, member=True),
                 403, None),
                ("module without membership", self.user(f"c-{module}", modules=[module],
                                                        member=False),
                 200, everywhere if module in MODULE_ONLY else 0),
            )
            for label, user, status, count in cases:
                with self.subTest(module=module, user=label):
                    self.client.force_login(user)
                    response = self.client.get(path)
                    self.assertEqual(response.status_code, status)
                    if status == 200 and count is not None:
                        self.assertEqual(len(rows(response)), count)

    def test_detail_in_an_invisible_project_is_not_found(self):
        user = self.user("emp", modules=MODULES, member=True)
        self.client.force_login(user)
        theirs = Task.objects.get(project=self.theirs)
        lead = Lead.objects.get(project=self.theirs)
        payment = Payment.objects.get(project=self.theirs)
        for path in (
            f"/api/tasks/{theirs.key}/",
            f"/api/crm/leads/{lead.key}/",
            f"/api/crm/payments/{payment.pk}/",
        ):
            with self.subTest(path=path):
                response = self.client.patch(path, {}, content_type="application/json")
                self.assertEqual(response.status_code, 404)


class MiddlewareTests(TestCase):
    def setUp(self):
        self.emp = User.objects.create_user("emp")
        self.client.force_login(self.emp)

    def test_unlisted_prefix_is_refused_even_with_every_module(self):
        grant(self.emp, MODULES)
        for path in ("/api/webhooks/", "/api/mcp/tokens/", "/api/access/"):
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(self.client.post("/api/projects/", {}).status_code, 403)
        self.assertEqual(self.client.post("/api/columns/", {}).status_code, 403)

    def test_payments_need_billing_even_with_crm(self):
        grant(self.emp, ["crm"])
        self.assertEqual(self.client.get("/api/crm/leads/").status_code, 200)
        self.assertEqual(self.client.get("/api/crm/payments/").status_code, 403)
        grant(self.emp, ["billing"])
        self.client.force_login(User.objects.get(pk=self.emp.pk))
        self.assertEqual(self.client.get("/api/crm/payments/").status_code, 200)
        self.assertEqual(self.client.get("/api/crm/leads/").status_code, 403)
        # The company picker and scope switcher serve billing too.
        self.assertEqual(self.client.get("/api/crm/contacts/").status_code, 200)

    def test_operations_cannot_edit_or_run_routines(self):
        # A routine runs as Hermes, outside any module or project.
        grant(self.emp, ["operations"])
        base = "/api/integrations/routines/job1"
        self.assertEqual(
            self.client.patch(f"{base}/", {"prompt": "x"}, content_type="application/json").status_code,
            403,
        )
        self.assertEqual(self.client.post(f"{base}/run/").status_code, 403)
        self.assertEqual(self.client.get(f"{base}/runs/cron_job1_20260101_000000/").status_code, 403)

    def test_me_lists_the_modules(self):
        grant(self.emp, ["wiki", "tasks", "nonsense"])
        self.assertEqual(self.client.get("/api/auth/me/").json()["modules"], ["tasks", "wiki"])
        self.client.force_login(User.objects.create_user("boss", is_staff=True))
        self.assertEqual(sorted(self.client.get("/api/auth/me/").json()["modules"]),
                         sorted(MODULES))


class CrossModuleTests(TestCase):
    def setUp(self):
        self.mine = Project.objects.create(name="Mowafeq", prefix="MOW")
        self.theirs = Project.objects.create(name="Shelter", prefix="SHE")
        self.boss = User.objects.create_user("boss", is_staff=True)
        self.emp = User.objects.create_user("emp")
        self.mine.members.add(self.emp)
        self.client.force_login(self.emp)

    def test_contact_search_skips_entities_of_invisible_projects(self):
        grant(self.emp, ["crm"])
        ours = Entity.objects.create(kind=EntityKind.COMPANY, name="Acme One", slug="acme-one")
        theirs = Entity.objects.create(kind=EntityKind.COMPANY, name="Acme Two", slug="acme-two")
        Lead.objects.create(title="ours", project=self.mine, company=ours)
        Lead.objects.create(title="theirs", project=self.theirs, company=theirs)
        found = [c["name"] for c in rows(self.client.get("/api/crm/contacts/?search=acme"))]
        self.assertEqual(found, ["Acme One"])
        self.assertEqual(self.client.get(f"/api/crm/contacts/{theirs.pk}/").status_code, 404)

    def test_contact_company_from_another_projects_crm_is_refused(self):
        # Linking it would make it visible through its new employee.
        grant(self.emp, ["crm"])
        person = Entity.objects.create(kind=EntityKind.PERSON, name="Sara", slug="sara")
        update = Update.objects.create(
            lead=Lead.objects.create(title="ours", project=self.mine),
            body="call", occurred_at=timezone.now(),
        )
        update.people.add(person)
        theirs = Entity.objects.create(kind=EntityKind.COMPANY, name="Secret", slug="secret")
        Lead.objects.create(title="theirs", project=self.theirs, company=theirs)
        resp = self.client.patch(
            f"/api/crm/contacts/{person.pk}/", {"company": str(theirs.pk)},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        person.refresh_from_db()
        self.assertIsNone(person.company_id)
        self.assertEqual(self.client.get(f"/api/crm/contacts/{theirs.pk}/").status_code, 404)

    def test_meeting_curation_cannot_give_another_projects_person_a_company(self):
        # The company link would make the person visible through its leads.
        grant(self.emp, ["meetings", "crm"])
        acme = Entity.objects.create(kind=EntityKind.COMPANY, name="Acme", slug="acme")
        Lead.objects.create(title="ours", project=self.mine, company=acme)
        jane = Entity.objects.create(kind=EntityKind.PERSON, name="Jane Roe", slug="jane-roe")
        Update.objects.create(
            lead=Lead.objects.create(title="theirs", project=self.theirs),
            body="call", occurred_at=timezone.now(),
        ).people.add(jane)
        meeting = Meeting.objects.create(
            stem="m", title="ours", started_at=timezone.now(), project=self.mine
        )
        resp = self.client.patch(
            f"/api/meetings/{meeting.key}/",
            {"entities": [{"kind": "person", "name": "Jane Roe", "company": "Acme"}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        jane.refresh_from_db()
        self.assertIsNone(jane.company_id)
        self.assertEqual(self.client.get(f"/api/crm/contacts/{jane.pk}/").status_code, 404)

    def test_company_only_another_project_bills_is_out_of_reach(self):
        grant(self.emp, ["crm"])
        acme = Entity.objects.create(
            kind=EntityKind.COMPANY, name="Acme", slug="acme", phone="+974 1",
        )
        Payment.objects.create(
            title="p", company=acme, project=self.theirs, type="one_off",
            amount=Decimal("10"), due_on=date(2026, 12, 1),
        )
        resp = self.client.post(
            "/api/crm/leads/", {"title": "pilot", "project": self.mine.pk, "company": acme.pk},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post(
            "/api/crm/contacts/", {"kind": "company", "name": "Acme", "phone": "+1 evil"},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        acme.refresh_from_db()
        self.assertEqual(acme.phone, "+974 1")

    def test_billing_create_by_name_does_not_edit_the_contact(self):
        grant(self.emp, ["billing"])
        company = Entity.objects.create(
            kind=EntityKind.COMPANY, name="ECG", slug="ecg", phone="+974 1",
        )
        Payment.objects.create(
            title="p", company=company, project=self.mine, type="one_off",
            amount=Decimal("10"), due_on=date(2026, 12, 1),
        )
        resp = self.client.post(
            "/api/crm/contacts/", {"kind": "company", "name": "ECG", "phone": "+1 evil"},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        company.refresh_from_db()
        self.assertEqual(company.phone, "+974 1")

    def test_task_sources_hide_a_lead_without_crm(self):
        grant(self.emp, ["tasks"])
        lead = Lead.objects.create(title="pilot", project=self.mine)
        task = Task.objects.create(project=self.mine, title="send deck", reporter=self.boss)
        Update.objects.create(lead=lead, body="call", occurred_at=timezone.now(), task=task)
        self.assertEqual(self.client.get(f"/api/tasks/{task.key}/").json()["sources"], [])
        grant(self.emp, ["tasks", "crm"])
        self.client.force_login(User.objects.get(pk=self.emp.pk))
        sources = self.client.get(f"/api/tasks/{task.key}/").json()["sources"]
        self.assertEqual([s["key"] for s in sources], [lead.key])

    def test_meeting_shows_linked_tasks_only_with_the_tasks_module(self):
        grant(self.emp, ["meetings"])
        task = Task.objects.create(project=self.mine, title="t", reporter=self.boss)
        meeting = Meeting.objects.create(
            stem="a", title="ours", started_at=timezone.now(), project=self.mine
        )
        meeting.tasks.add(task, through_defaults={})
        detail = self.client.get(f"/api/meetings/{meeting.key}/").json()
        self.assertEqual(detail["linked_tasks"], [])
        resp = self.client.post(
            f"/api/meetings/{meeting.key}/tasks/", {"task": task.key},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 403)
        grant(self.emp, ["meetings", "tasks"])
        self.client.force_login(User.objects.get(pk=self.emp.pk))
        detail = self.client.get(f"/api/meetings/{meeting.key}/").json()
        self.assertEqual([t["key"] for t in detail["linked_tasks"]], [task.key])

    def test_task_create_needs_a_visible_project(self):
        grant(self.emp, ["tasks"])
        for project, status in ((self.mine, 201), (self.theirs, 400)):
            resp = self.client.post(
                "/api/tasks/", {"title": "x", "project_id": project.pk},
                content_type="application/json",
            )
            self.assertEqual(resp.status_code, status, project.prefix)


class AccessApiTests(TestCase):
    def setUp(self):
        self.project = Project.objects.create(name="Mowafeq", prefix="MOW")
        self.boss = User.objects.create_user("boss", is_staff=True)
        self.emp = User.objects.create_user("emp")

    def test_non_staff_are_refused(self):
        grant(self.emp, MODULES)
        self.client.force_login(self.emp)
        self.assertEqual(self.client.get("/api/access/").status_code, 403)
        resp = self.client.patch(
            f"/api/access/users/{self.emp.pk}/", {"modules": ["tasks"]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_patch_writes_modules_and_memberships(self):
        self.client.force_login(self.boss)
        resp = self.client.patch(
            f"/api/access/users/{self.emp.pk}/",
            {"modules": ["wiki", "tasks"], "project_ids": [self.project.pk]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["modules"], ["tasks", "wiki"])
        self.assertEqual(resp.json()["project_ids"], [self.project.pk])
        self.assertEqual(UserProfile.objects.get(user=self.emp).modules, ["tasks", "wiki"])
        self.assertTrue(self.project.members.filter(pk=self.emp.pk).exists())
        matrix = self.client.get("/api/access/").json()
        self.assertEqual(matrix["modules"], list(MODULES))
        row = next(u for u in matrix["users"] if u["id"] == self.emp.pk)
        self.assertEqual(row["project_ids"], [self.project.pk])

    def test_bad_input_is_refused(self):
        self.client.force_login(self.boss)
        url = f"/api/access/users/{self.emp.pk}/"
        for body in ({"modules": ["tasks", "nope"]}, {"project_ids": [999]}):
            resp = self.client.patch(url, body, content_type="application/json")
            self.assertEqual(resp.status_code, 400, body)
        staff_row = self.client.patch(
            f"/api/access/users/{self.boss.pk}/", {"modules": []},
            content_type="application/json",
        )
        self.assertEqual(staff_row.status_code, 400)


class McpAccessTests(TestCase):
    def setUp(self):
        self.mine = Project.objects.create(name="Mowafeq", prefix="MOW")
        self.theirs = Project.objects.create(name="Shelter", prefix="SHE")
        self.boss = User.objects.create_user("boss", is_staff=True)
        self.emp = User.objects.create_user("emp")
        self.mine.members.add(self.emp)

    def test_call_tool_needs_the_module(self):
        from asgiref.sync import async_to_sync

        from apps.mcp_server.auth import SCOPE_SCOPES_KEY, SCOPE_USER_KEY
        from apps.mcp_server.server import mcp
        from apps.mcp_server.tests import fake_request_ctx, reset_request_ctx

        grant(self.emp, ["wiki"])
        token = fake_request_ctx({SCOPE_USER_KEY: self.emp, SCOPE_SCOPES_KEY: ["read"]})
        try:
            with self.assertRaisesMessage(Exception, "'tasks' module"):
                async_to_sync(mcp.call_tool)("list_tasks", {})
        finally:
            reset_request_ctx(token)

    def test_task_in_an_invisible_project_is_not_found(self):
        from apps.mcp_server import tools

        grant(self.emp, ["tasks"])
        ours = Task.objects.create(project=self.mine, title="ours", reporter=self.boss)
        theirs = Task.objects.create(project=self.theirs, title="theirs", reporter=self.boss)
        self.assertEqual(tools.get_task(ours.key, mcp_user=self.emp)["key"], ours.key)
        with self.assertRaises(Task.DoesNotExist):
            tools.get_task(theirs.key, mcp_user=self.emp)
        with self.assertRaises(Project.DoesNotExist):
            tools.create_task(project="SHE", title="x", mcp_user=self.emp)

    def test_crm_lead_in_an_invisible_project_is_not_found(self):
        from apps.crm import mcp_tools

        grant(self.emp, ["crm"])
        theirs = Lead.objects.create(title="theirs", project=self.theirs)
        with self.assertRaisesMessage(ValueError, "not found"):
            mcp_tools.get_lead(theirs.key, mcp_user=self.emp)
        self.assertEqual(mcp_tools.search_leads(mcp_user=self.emp), [])
        with mock.patch("apps.crm.services.broadcast_crm_event"):
            with self.assertRaisesMessage(ValueError, "No project"):
                mcp_tools.upsert_lead(title="x", project="SHE", mcp_user=self.emp)


class LegacyAccessMigrationTests(TestCase):
    """Existing non-staff users keep exactly what they reached before."""

    def test_non_staff_get_the_legacy_modules_and_staff_none(self):
        migration = importlib.import_module("apps.tasks.migrations.0036_userprofile_modules")
        emp = User.objects.create_user("emp")
        boss = User.objects.create_user("boss", is_staff=True)
        UserProfile.objects.filter(user=emp).delete()  # one with no profile yet
        migration.grant_legacy_modules(django_apps, None)
        self.assertEqual(UserProfile.objects.get(user=emp).modules, LEGACY)
        self.assertEqual(UserProfile.objects.get(user=boss).modules, [])


class LegacyEmployeeTests(TestCase):
    """The pre-module employee rules, unchanged behind their module gates."""

    def setUp(self):
        self.mine = Project.objects.create(name="Mowafeq", prefix="MOW")
        self.theirs = Project.objects.create(name="Shelter", prefix="SHE")
        self.employee = User.objects.create_user("emp", password="x")
        grant(self.employee, LEGACY)
        self.mine.members.add(self.employee)
        self.boss = User.objects.create_user("boss", password="x", is_staff=True)
        self.client.force_login(self.employee)

    def test_legacy_apps_stay_reachable_and_tasks_stay_closed(self):
        self.assertEqual(self.client.get("/api/meetings/").status_code, 200)
        self.assertEqual(self.client.get("/api/wiki-docs/").status_code, 200)
        for path in ("/api/tasks/", "/api/columns/", "/api/me/focus/", "/api/bets/",
                     "/api/integrations/routines/", "/api/crm/contacts/",
                     "/api/analytics/throughput/", "/api/mcp/tokens/"):
            self.assertEqual(self.client.get(path).status_code, 403, path)
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

    def test_module_gate_empties_the_inner_rules(self):
        Doc.objects.create(title="own draft", created_by=self.employee)
        DriveFile.objects.create(key="uploads/mine.pdf", uploaded_by=self.employee)
        KnowledgePageProject.objects.create(slug="projects/mowafeq", project=self.mine)
        grant(self.employee, [])
        fresh = User.objects.get(pk=self.employee.pk)
        self.assertEqual(visible_doc_ids(fresh), set())
        self.assertEqual(visible_drive_keys(fresh), set())
        self.assertEqual(visible_knowledge_slugs(fresh), set())
