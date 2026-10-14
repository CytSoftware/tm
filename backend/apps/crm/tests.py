"""CRM: leads on a fixed board, update threads, what they need next as a task
linked to the update, and the derived "in the CRM" membership.

The cases that matter most are the derived ones (``MembershipTests`` and the
lead's current next step) — a CRM whose lists or next steps drift is the one
nobody trusts.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone as dt_timezone
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.meetings import services as meeting_services
from apps.meetings.models import Entity, EntityKind, Meeting
from apps.tasks.models import ColumnKind, Project, Task

from . import mcp_tools, services
from .models import Lead, LeadStage, Update
from .query import filter_contacts, filter_leads, filter_updates


class CrmTestCase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("crm-user", is_staff=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        for target in (
            "apps.crm.services.broadcast_crm_event",
            "apps.crm.services.broadcast_task_event",
            "apps.crm.services.notify_task_event",
        ):
            patcher = mock.patch(target)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.mow = Project.objects.create(name="mowafeq", prefix="MOW")
        self.ecg, _ = services.create_contact({"kind": "company", "name": "ECG"})
        self.mohamed, _ = services.create_contact(
            {"kind": "person", "name": "Mohamed Mohsen", "company": "ECG"}
        )

    def lead(self, **data):
        return services.create_lead(
            {"title": "ECG — Mowafeq pilot", "company": self.ecg, "project": self.mow, **data},
            user=self.user,
        )


class ContactTests(CrmTestCase):
    def test_create_reuses_meeting_entity(self):
        existing = meeting_services.resolve_entity(EntityKind.PERSON, "Ali K.")
        entity, created = services.create_contact({"kind": "person", "name": "ali k"})
        self.assertFalse(created)
        self.assertEqual(entity.pk, existing.pk)

    def test_email_is_unique_across_entities(self):
        services.update_contact(self.mohamed, {"emails": ["mo@ecg.com"]})
        other, _ = services.create_contact({"kind": "person", "name": "Sami"})
        with self.assertRaises(services.CrmError):
            services.update_contact(other, {"emails": ["MO@ecg.com"]})

    def test_merge_repoints_leads_and_updates(self):
        lead = self.lead()
        dup = meeting_services.resolve_entity(EntityKind.PERSON, "Mohamed M.")
        services.post_update({"body": "call"}, user=self.user, lead=lead, people=[dup])
        dup_company = meeting_services.resolve_entity(EntityKind.COMPANY, "ECG Engineering")
        Lead.objects.filter(pk=lead.pk).update(company=dup_company)
        meeting_services.merge_entities(dup, self.mohamed)
        meeting_services.merge_entities(dup_company, self.ecg)
        self.assertEqual(Update.objects.get().people.get(), self.mohamed)
        self.assertEqual(Lead.objects.get().company, self.ecg)


class MembershipTests(CrmTestCase):
    def ids(self, **filters):
        return set(filter_contacts(filters).values_list("pk", flat=True))

    def test_only_entities_on_a_lead_or_update_are_listed(self):
        stranger = meeting_services.resolve_entity(EntityKind.PERSON, "Met Once")
        self.assertEqual(self.ids(), set())
        self.lead()
        # The company has a lead, so it and its people are in.
        self.assertEqual(self.ids(), {self.ecg.pk, self.mohamed.pk})
        services.post_update({"body": "coffee"}, user=self.user, people=[stranger])
        self.assertIn(stranger.pk, self.ids())

    def test_search_reaches_everyone(self):
        meeting_services.resolve_entity(EntityKind.PERSON, "Met Once")
        self.assertEqual(len(self.ids(search="met once")), 1)

    def test_last_update_rolls_up_to_the_company(self):
        lead = self.lead()
        when = timezone.now() - timedelta(days=2)
        services.post_update(
            {"body": "pinged", "occurred_at": when}, user=self.user, lead=lead, people=[self.mohamed]
        )
        company = filter_contacts().get(pk=self.ecg.pk)
        self.assertEqual(company.last_update_at, when)
        self.assertEqual(company.open_lead_count, 1)


class LeadTests(CrmTestCase):
    def test_closing_stamps_and_reopening_clears(self):
        lead = self.lead()
        self.assertIsNone(lead.closed_at)
        services.update_lead(lead, {"stage": LeadStage.LOST, "lost_reason": "Went with Aconex"})
        self.assertIsNotNone(lead.closed_at)
        self.assertEqual(lead.lost_reason, "Went with Aconex")
        services.move_lead(lead, LeadStage.DEMO)
        self.assertIsNone(lead.closed_at)
        self.assertEqual(lead.lost_reason, "")

    def test_move_places_between_siblings(self):
        a, b, c = self.lead(title="a"), self.lead(title="b"), self.lead(title="c")
        services.move_lead(c, LeadStage.NEW, index=1)
        order = list(filter_leads({"stage": "new"}).values_list("title", flat=True))
        self.assertEqual(order, ["a", "c", "b"])

    def test_person_matches_their_employers_leads(self):
        self.lead()
        self.assertEqual(filter_leads({"entity": self.mohamed.pk}).count(), 1)


class UpdateTests(CrmTestCase):
    def test_needs_a_lead_or_a_person(self):
        with self.assertRaises(services.CrmError):
            services.post_update({"body": "orphan"}, user=self.user)

    def test_meeting_sets_kind_and_time(self):
        start = datetime(2026, 10, 11, 14, 27, tzinfo=dt_timezone.utc)
        meeting = Meeting.objects.create(stem="s1", title="Intro", started_at=start)
        update = services.post_update(
            {"body": "Wants a full presentation"}, user=self.user, lead=self.lead(), meeting=meeting
        )
        self.assertEqual((update.kind, update.occurred_at), ("meeting", start))

    def test_next_step_is_a_task_linked_to_its_update(self):
        lead = self.lead()
        update = services.post_update(
            {"body": "He'll confirm the date", "next_step": "Chase ECG", "next_due": "2026-10-19"},
            user=self.user,
            lead=lead,
        )
        task = update.task
        self.assertEqual((task.project, task.column.kind, task.title), (self.mow, ColumnKind.TODO, "Chase ECG"))
        self.assertEqual(list(task.assignees.all()), [self.user])
        self.assertEqual(filter_leads().get(pk=lead.pk).next_step_key, task.key)

        # A later update without a step doesn't clear it; ticking it off does.
        services.post_update({"body": "Still waiting"}, user=self.user, lead=lead)
        self.assertEqual(filter_leads().get(pk=lead.pk).next_step_key, task.key)
        services.set_step_done(task, True, user=self.user)
        self.assertEqual(Task.objects.get(pk=task.pk).column.kind, ColumnKind.DONE)
        self.assertIsNone(filter_leads().get(pk=lead.pk).next_step_key)

    def test_next_step_needs_a_lead_with_a_project(self):
        with self.assertRaises(services.CrmError):
            services.post_update(
                {"body": "x", "next_step": "Chase"}, user=self.user, lead=self.lead(project=None)
            )
        with self.assertRaises(services.CrmError):
            services.post_update({"body": "x", "next_step": "Chase"}, user=self.user, people=[self.mohamed])

    def test_company_history_lists_an_update_once(self):
        hala, _ = services.create_contact({"kind": "person", "name": "Hala", "company": "ECG"})
        services.post_update({"body": "both"}, user=self.user, lead=self.lead(), people=[self.mohamed, hala])
        self.assertEqual(filter_updates({"entity": self.ecg.pk}).count(), 1)

    def test_activity_scopes_by_project(self):
        services.post_update({"body": "mow"}, user=self.user, lead=self.lead())
        services.post_update({"body": "loose"}, user=self.user, people=[self.mohamed])
        self.assertEqual(filter_updates().count(), 2)
        self.assertEqual([u.body for u in filter_updates({"project": "MOW"})], ["mow"])


class ApiTests(CrmTestCase):
    def test_lead_thread_round_trip(self):
        r = self.client.post(
            "/api/crm/leads/",
            {"title": "ECG pilot", "company": self.ecg.pk, "project": self.mow.pk},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        key = r.json()["key"]
        r = self.client.post(
            "/api/crm/updates/",
            {"lead": key, "kind": "call", "body": "Out of Doha", "people": [self.mohamed.pk],
             "next_step": "Chase", "next_due": "2026-10-19"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual([u["username"] for u in r.json()["users"]], ["crm-user"])

        detail = self.client.get(f"/api/crm/leads/{key}/").json()
        self.assertEqual([p["name"] for p in detail["people"]], ["Mohamed Mohsen"])
        self.assertEqual(detail["next_step"]["title"], "Chase")
        step = detail["updates"][0]["task"]["key"]
        self.assertEqual([s["key"] for s in detail["steps"]], [step])
        r = self.client.post(f"/api/crm/steps/{step}/", {"done": True}, format="json")
        self.assertFalse(r.json()["is_open"])

        # The task itself says where it came from.
        sources = self.client.get(f"/api/tasks/{step}/").json()["sources"]
        self.assertEqual(sources, [{"kind": "lead", "key": key, "title": "ECG pilot", "company": "ECG"}])

        people = self.client.get("/api/crm/contacts/", {"kind": "person"}).json()["results"]
        self.assertEqual([p["name"] for p in people], ["Mohamed Mohsen"])


class McpTests(CrmTestCase):
    def test_post_update_by_names(self):
        lead = mcp_tools.upsert_lead(title="ECG pilot", company="ECG", project="MOW", mcp_user=self.user)
        out = mcp_tools.post_update(
            "Called, he'll confirm Thursday",
            lead=lead["key"],
            kind="call",
            people=["Mohamed Mohsen"],
            next_step="Chase",
            next_due="2026-10-19",
            mcp_user=self.user,
        )
        self.assertEqual(out["people"], ["Mohamed Mohsen"])
        self.assertTrue(out["task"]["key"].startswith("MOW-"))
        got = mcp_tools.get_lead(lead["key"])
        self.assertEqual(got["next_step"]["title"], "Chase")
        self.assertEqual(got["updates"][0]["kind"], "call")
        mcp_tools.complete_next_step(out["task"]["key"], mcp_user=self.user)
        self.assertEqual(mcp_tools.get_lead(lead["key"])["open_steps"], [])

    def test_unknown_stage_is_refused(self):
        with self.assertRaises(ValueError):
            mcp_tools.upsert_lead(title="x", stage="closing", mcp_user=self.user)
