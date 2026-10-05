"""CRM: contacts on meeting entities, derived dates, follow-ups as tasks,
touchpoint idempotency, deals/pipelines, and the MCP translation layer.

The cases that matter most are the derived ones (``DerivedDateTests``) and
``TouchpointTests.test_external_id_upserts`` — a CRM whose dates drift or
whose Gmail ingest duplicates on every run is the one nobody trusts.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone as dt_timezone
from unittest import mock
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.meetings import services as meeting_services
from apps.meetings.models import Entity, EntityEmail, EntityKind, Meeting, MeetingEntity
from apps.tasks.models import ColumnKind, Task

from . import mcp_tools, services
from .models import Deal, FollowUp, Pipeline, StageKind, Touchpoint
from .query import bucket_follow_ups, filter_contacts, open_follow_ups, real_date
from .timeline import entity_timeline

DOHA = ZoneInfo("Asia/Qatar")


class CrmTestCase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("crm-user")
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
        self.sales = Pipeline.objects.get(slug="sales")

    def person(self, name="Mohamed Mohsen", company="ECG", **fields):
        entity, _ = services.create_contact(
            {"kind": "person", "name": name, "company": company, **fields}
        )
        return entity

    def meeting(self, entity, when, stem="s1", role="attendee"):
        m = Meeting.objects.create(stem=stem, title=f"Meeting {stem}", started_at=when)
        MeetingEntity.objects.create(meeting=m, entity=entity, role=role)
        return m

    def contact(self, entity):
        return filter_contacts({"relationship": "any"}).get(pk=entity.pk)


class ContactTests(CrmTestCase):
    def test_create_reuses_meeting_entity(self):
        existing = meeting_services.resolve_entity(EntityKind.PERSON, "Ali K.")
        entity, created = services.create_contact({"kind": "person", "name": "ali k"})
        self.assertFalse(created)
        self.assertEqual(entity.pk, existing.pk)
        self.assertEqual(entity.relationship, "lead")  # promoted into the CRM

    def test_company_by_name_is_created_and_linked(self):
        p = self.person()
        self.assertEqual(p.company.name, "ECG")
        self.assertEqual(p.company.kind, EntityKind.COMPANY)

    def test_only_people_belong_to_companies(self):
        company, _ = services.create_contact({"kind": "company", "name": "Worley"})
        with self.assertRaises(services.CrmError):
            services.update_contact(company, {"company": "ECG"})

    def test_email_is_unique_across_entities(self):
        a = self.person("A", emails=["a@ecg.com"])
        self.person("B", emails=[])
        b = Entity.objects.get(name="B")
        with self.assertRaises(services.CrmError):
            services.update_contact(b, {"add_emails": ["A@ECG.com"]})
        self.assertEqual(EntityEmail.objects.get(email="a@ecg.com").entity, a)

    def test_internal_and_untracked_are_hidden_by_default(self):
        self.person("Ali Soukarieh", company=None, relationship="internal")
        meeting_services.resolve_entity(EntityKind.PERSON, "Random Speaker")
        self.person("Lead Person", company=None)
        names = set(filter_contacts().values_list("name", flat=True))
        self.assertEqual(names, {"Lead Person"})

    def test_rename_moves_slug_so_ingest_lands_here(self):
        p = self.person("Mohamed", company=None)
        services.update_contact(p, {"name": "Mohamed Mohsen"})
        self.assertEqual(meeting_services.resolve_entity(EntityKind.PERSON, "Mohamed Mohsen"), p)
        self.assertEqual(meeting_services.resolve_entity(EntityKind.PERSON, "Mohamed"), p)
        other = self.person("Someone Else", company=None)
        with self.assertRaises(services.CrmError):
            services.update_contact(other, {"name": "mohamed mohsen"})

    def test_merge_folds_crm_state(self):
        keep = self.person("Sofia", company="Al Madar")
        dupe = meeting_services.resolve_entity(EntityKind.PERSON, "Sofia A.")
        services.update_contact(dupe, {"phone": "+974 5555", "add_emails": ["s@madar.qa"]})
        services.create_follow_up(dupe, "Call Sofia", user=self.user)
        meeting_services.merge_entities(dupe, keep)
        keep.refresh_from_db()
        self.assertEqual(keep.phone, "+974 5555")
        self.assertEqual(list(keep.emails.values_list("email", flat=True)), ["s@madar.qa"])
        self.assertEqual(FollowUp.objects.get().entity, keep)


class DerivedDateTests(CrmTestCase):
    def test_last_contact_is_latest_of_meeting_and_touchpoint(self):
        p = self.person()
        self.assertIsNone(real_date(self.contact(p).last_contact_at))
        self.meeting(p, datetime(2026, 9, 1, 10, tzinfo=DOHA))
        services.log_touchpoint(
            {"kind": "call", "summary": "Pinged", "occurred_at": datetime(2026, 10, 1, 9, tzinfo=DOHA)},
            [p],
            user=self.user,
        )
        self.assertEqual(
            real_date(self.contact(p).last_contact_at), datetime(2026, 10, 1, 9, tzinfo=DOHA)
        )

    def test_mentioned_meeting_is_not_contact(self):
        p = self.person()
        self.meeting(p, datetime(2026, 9, 1, tzinfo=DOHA), role="mentioned")
        self.assertIsNone(real_date(self.contact(p).last_contact_at))

    def test_company_rolls_up_people(self):
        p = self.person()
        when = datetime(2026, 9, 20, 15, tzinfo=DOHA)
        self.meeting(p, when)
        services.create_follow_up(p, "Pilot scope", user=self.user, due="2026-10-08")
        company = self.contact(p.company)
        self.assertEqual(real_date(company.last_contact_at), when)
        self.assertEqual(company.next_follow_up_at, datetime(2026, 10, 8, 9, tzinfo=DOHA))
        self.assertTrue(company.has_open_follow_up)

    def test_next_follow_up_ignores_done(self):
        p = self.person()
        task = services.create_follow_up(p, "Old", user=self.user, due="2026-10-01")
        services.create_follow_up(p, "New", user=self.user, due="2026-10-09")
        services.complete_follow_up(task.crm_follow_up, user=self.user)
        self.assertEqual(self.contact(p).next_follow_up_title, "New")

    def test_no_next_step_filter(self):
        a = self.person("Has step", company=None)
        self.person("No step", company=None)
        services.create_follow_up(a, "Call", user=self.user)
        names = list(filter_contacts({"no_next_step": True}).values_list("name", flat=True))
        self.assertEqual(names, ["No step"])


class FollowUpTests(CrmTestCase):
    def test_lives_in_crm_project_with_columns(self):
        p = self.person(owner=None)
        task = services.create_follow_up(p, "Send deck", user=self.user, due="2026-10-08")
        self.assertEqual(task.project.prefix, "FUP")
        self.assertTrue(task.key.startswith("FUP-"))
        self.assertEqual(task.column.kind, ColumnKind.TODO)
        self.assertEqual(list(task.assignees.all()), [self.user])
        # Second call reuses the project.
        again = services.create_follow_up(p, "Again", user=self.user)
        self.assertEqual(again.project_id, task.project_id)

    def test_assigned_to_contact_owner(self):
        ali = get_user_model().objects.create_user("ali")
        p = self.person(owner=ali)
        task = services.create_follow_up(p, "Call", user=self.user)
        self.assertEqual(list(task.assignees.all()), [ali])

    def test_due_needs_offset_or_date(self):
        p = self.person()
        with self.assertRaises(services.CrmError):
            services.create_follow_up(p, "x", user=self.user, due="2026-10-08T10:00:00")

    def test_complete_and_reopen(self):
        p = self.person()
        f = services.create_follow_up(p, "Call", user=self.user).crm_follow_up
        services.complete_follow_up(f, user=self.user)
        f.task.refresh_from_db()
        self.assertTrue(f.task.column.is_done)
        self.assertFalse(open_follow_ups().exists())
        services.reopen_follow_up(f, user=self.user)
        self.assertTrue(open_follow_ups().exists())

    def test_buckets_use_local_dates(self):
        p = self.person()
        now = timezone.now().astimezone(DOHA)
        for title, delta in (("late", -2), ("today", 0), ("soon", 3), ("far", 30)):
            services.create_follow_up(
                p, title, user=self.user, due=(now + timedelta(days=delta)).date().isoformat()
            )
        services.create_follow_up(p, "undated", user=self.user)
        _today, groups = bucket_follow_ups(open_follow_ups(), DOHA)
        titles = {k: [f.task.title for f in v] for k, v in groups.items()}
        self.assertEqual(titles["overdue"], ["late"])
        self.assertEqual(titles["today"], ["today"])
        self.assertEqual(titles["week"], ["soon"])
        self.assertEqual(sorted(titles["later"]), ["far", "undated"])


class TouchpointTests(CrmTestCase):
    def test_external_id_upserts(self):
        p = self.person()
        data = {
            "kind": "email",
            "summary": "Re: pilot",
            "source": "gmail",
            "external_id": "msg-1",
            "follow_up": {"title": "Reply"},
        }
        t1, created1, task1 = services.log_touchpoint(dict(data), [p], user=self.user)
        t2, created2, task2 = services.log_touchpoint(
            {**data, "summary": "Re: pilot (edited)"}, [p.company], user=self.user
        )
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(t1.pk, t2.pk)
        self.assertEqual(Touchpoint.objects.count(), 1)
        self.assertEqual(t2.summary, "Re: pilot (edited)")
        self.assertEqual(set(t2.entities.all()), {p, p.company})  # additive
        self.assertIsNotNone(task1)
        self.assertIsNone(task2)  # a re-push doesn't file the follow-up twice

    def test_naive_time_refused(self):
        p = self.person()
        with self.assertRaises(services.CrmError):
            services.log_touchpoint(
                {"kind": "call", "summary": "x", "occurred_at": datetime(2026, 10, 1, 9)},
                [p],
                user=self.user,
            )

    def test_timeline_unions_sources(self):
        p = self.person()
        self.meeting(p, datetime(2026, 9, 1, tzinfo=DOHA))
        services.log_touchpoint(
            {"kind": "whatsapp", "summary": "Sent deck", "occurred_at": datetime(2026, 9, 5, tzinfo=DOHA)},
            [p],
            user=self.user,
        )
        f = services.create_follow_up(p, "Call back", user=self.user).crm_follow_up
        services.complete_follow_up(f, user=self.user)
        kinds = [i["type"] for i in entity_timeline(p.company)]
        self.assertEqual(kinds, ["follow_up", "touchpoint", "meeting"])


class DealTests(CrmTestCase):
    def test_key_and_default_stage(self):
        deal = services.create_deal({"title": "ECG pilot", "pipeline": self.sales}, user=self.user)
        self.assertEqual(deal.key, "DEAL-001")
        self.assertEqual(deal.stage.name, "Discovery")

    def test_move_sets_and_clears_closed_at(self):
        deal = services.create_deal({"title": "X", "pipeline": self.sales}, user=self.user)
        won = self.sales.stages.get(kind=StageKind.WON)
        services.move_deal(deal, won)
        self.assertIsNotNone(deal.closed_at)
        services.move_deal(deal, self.sales.stages.get(name="Demo"))
        self.assertIsNone(deal.closed_at)

    def test_stage_must_match_pipeline(self):
        other = Pipeline.objects.get(slug="fundraising")
        deal = services.create_deal({"title": "X", "pipeline": self.sales}, user=self.user)
        with self.assertRaises(services.CrmError):
            services.move_deal(deal, other.stages.first())

    def test_move_index_orders(self):
        demo = self.sales.stages.get(name="Demo")
        a, b, c = (
            services.create_deal({"title": t, "pipeline": self.sales, "stage": demo}, user=self.user)
            for t in "abc"
        )
        services.move_deal(c, demo, index=0)
        order = list(Deal.objects.filter(stage=demo).order_by("position").values_list("title", flat=True))
        self.assertEqual(order, ["c", "a", "b"])

    def test_set_stages_refuses_dropping_a_stage_with_deals(self):
        services.create_deal({"title": "X", "pipeline": self.sales}, user=self.user)
        keep = [{"id": s.id, "name": s.name, "kind": s.kind} for s in self.sales.stages.exclude(name="Discovery")]
        with self.assertRaises(services.CrmError):
            services.set_stages(self.sales, keep)

    def test_set_stages_renames_reorders_adds(self):
        stages = list(self.sales.stages.all())
        spec = [{"id": s.id, "name": s.name, "kind": s.kind} for s in reversed(stages)]
        spec[0]["kind"] = "open"
        spec.append({"name": "Negotiation"})
        services.set_stages(self.sales, spec)
        names = list(self.sales.stages.values_list("name", flat=True))
        self.assertEqual(names[0], "Lost")
        self.assertEqual(names[-1], "Negotiation")


class RestTests(CrmTestCase):
    def test_contact_create_list_detail(self):
        res = self.client.post(
            "/api/crm/contacts/",
            {"kind": "person", "name": "Ramzi Mazloum", "relationship": "lead", "emails": ["r@x.com"]},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.data)
        cid = res.data["id"]
        res = self.client.get("/api/crm/contacts/?search=r@x")
        self.assertEqual([c["id"] for c in res.data["results"]], [cid])
        res = self.client.get(f"/api/crm/contacts/{cid}/")
        self.assertEqual(res.status_code, 200)
        self.assertIn("timeline", res.data)

    def test_inbox(self):
        p = self.person()
        self.client.post(
            "/api/crm/follow-ups/",
            {"entity": p.id, "title": "Call", "due": "2000-01-01"},
            format="json",
        )
        res = self.client.get("/api/crm/inbox/?tz=Asia/Qatar&owner=me")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data["buckets"]["overdue"]), 1)

    def test_deal_move_endpoint(self):
        deal = services.create_deal({"title": "X", "pipeline": self.sales}, user=self.user)
        stage = self.sales.stages.get(name="Pilot")
        res = self.client.post(f"/api/crm/deals/{deal.key}/move/", {"stage": stage.id}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["stage"]["name"], "Pilot")

    def test_refused_write_is_400(self):
        res = self.client.put(
            f"/api/crm/pipelines/{self.sales.id}/stages/",
            {"stages": [{"name": "Won", "kind": "won"}]},
            format="json",
        )
        self.assertEqual(res.status_code, 400)


class McpTests(CrmTestCase):
    def test_upsert_log_and_read_back(self):
        out = mcp_tools.upsert_contact(
            "Mohamed Mohsen", company="ECG", emails=["m@ecg.com"], headline="BIM Director"
        )
        self.assertTrue(out["created"])
        again = mcp_tools.upsert_contact("mohamed mohsen", phone="+974 1")
        self.assertFalse(again["created"])
        self.assertEqual(again["id"], out["id"])

        res = mcp_tools.log_touchpoint(
            "email",
            "Re: pilot",
            people=["m@ecg.com"],
            source="gmail",
            external_id="abc",
            occurred_at="2026-10-01T10:00:00+03:00",
            follow_up_title="Send pilot plan",
            follow_up_due="2026-10-08",
            mcp_user=self.user,
        )
        self.assertTrue(res["follow_up"].startswith("FUP-"))

        deal = mcp_tools.create_deal("ECG pilot", stage="pilot", company="ECG", contacts=["Mohamed Mohsen"])
        self.assertEqual(deal["stage"], "Pilot")

        contact = mcp_tools.get_contact("ECG", kind="company")
        self.assertEqual(contact["last_contact_at"][:10], "2026-10-01")
        self.assertEqual(len(contact["open_follow_ups"]), 1)
        self.assertEqual(contact["deals"][0]["key"], deal["key"])

        found = mcp_tools.find_contacts_by_email(["M@ecg.com", "nobody@x.com"])
        self.assertEqual(list(found["matches"]), ["m@ecg.com"])
        self.assertEqual(found["unknown"], ["nobody@x.com"])

        inbox = mcp_tools.list_follow_ups()
        self.assertEqual(sum(len(inbox[b]) for b in ("overdue", "today", "week", "later")), 1)

        done = mcp_tools.update_follow_up(res["follow_up"], done=True, mcp_user=self.user)
        self.assertFalse(done["is_open"])

    def test_read_tools_are_registered_read_only(self):
        from apps.mcp_server.server import READ_ONLY_TOOLS

        for name in ("search_contacts", "get_contact", "find_contacts_by_email", "list_follow_ups", "list_pipelines", "search_deals", "get_deal", "list_crm_activity"):
            self.assertIn(name, READ_ONLY_TOOLS)
        for name in ("upsert_contact", "log_touchpoint", "create_follow_up", "update_follow_up", "create_deal", "update_deal", "delete_deal", "add_contact_note", "update_touchpoint", "delete_touchpoint", "create_pipeline", "update_pipeline", "delete_pipeline"):
            self.assertNotIn(name, READ_ONLY_TOOLS)


class HistoryAndPipelineMcpTests(CrmTestCase):
    def test_note_edit_delete_and_activity(self):
        mcp_tools.upsert_contact("Ramzi Mazloum")
        note = mcp_tools.add_contact_note("Ramzi Mazloum", "Prefers WhatsApp after 6pm.", mcp_user=self.user)
        contact = mcp_tools.get_contact("Ramzi Mazloum")
        item = contact["timeline"][0]
        self.assertEqual((item["type"], item["kind"], item["id"]), ("touchpoint", "note", note["id"]))

        fixed = mcp_tools.update_touchpoint(note["id"], summary="Prefers WhatsApp after 7pm.")
        self.assertEqual(fixed["summary"], "Prefers WhatsApp after 7pm.")

        feed = mcp_tools.list_crm_activity(days=7)
        self.assertEqual([i["summary"] for i in feed if i["type"] == "touchpoint"], ["Prefers WhatsApp after 7pm."])

        mcp_tools.delete_touchpoint(note["id"])
        self.assertEqual(mcp_tools.get_contact("Ramzi Mazloum")["timeline"], [])

    def test_activity_includes_crm_meetings_only(self):
        p = self.person()
        stranger = meeting_services.resolve_entity(EntityKind.PERSON, "Stranger")
        now = timezone.now()
        self.meeting(p, now - timedelta(days=1), stem="in")
        self.meeting(stranger, now - timedelta(days=1), stem="out")
        self.meeting(p, now - timedelta(days=40), stem="old")
        feed = mcp_tools.list_crm_activity(days=14)
        self.assertEqual([i["title"] for i in feed], ["Meeting in"])

    def test_pipeline_lifecycle_keeps_stages_by_name(self):
        pipe = mcp_tools.create_pipeline("Partnerships", ["Intro", "Pilot", {"name": "Signed", "kind": "won"}])
        self.assertEqual([s["name"] for s in pipe["stages"]], ["Intro", "Pilot", "Signed"])
        deal = mcp_tools.create_deal("FD Consult channel", pipeline="Partnerships", stage="Pilot")
        # Reorder + rename-by-replacement; "Pilot" keeps its id, so the deal stays put.
        out = mcp_tools.update_pipeline("Partnerships", stages=["Pilot", "Intro", {"name": "Signed", "kind": "won"}])
        self.assertEqual([s["name"] for s in out["stages"]], ["Pilot", "Intro", "Signed"])
        self.assertEqual(mcp_tools.get_deal(deal["key"])["stage"], "Pilot")
        with self.assertRaises(ValueError):
            mcp_tools.update_pipeline("Partnerships", stages=["Intro", {"name": "Signed", "kind": "won"}])
        with self.assertRaises(ValueError):
            mcp_tools.delete_pipeline("Partnerships")
        mcp_tools.delete_deal(deal["key"])
        self.assertTrue(mcp_tools.delete_pipeline("Partnerships")["ok"])

    def test_rest_patch_touchpoint_and_last_activity(self):
        p = self.person()
        t, _, _ = services.log_touchpoint({"kind": "call", "summary": "First"}, [p], user=self.user)
        res = self.client.patch(f"/api/crm/touchpoints/{t.id}/", {"summary": "Edited"}, format="json")
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data["summary"], "Edited")
        row = self.client.get("/api/crm/contacts/?search=Mohamed").data["results"][0]
        self.assertEqual(row["last_activity"]["text"], "Edited")
        self.assertEqual(self.client.get("/api/crm/activity/?days=3").status_code, 200)
