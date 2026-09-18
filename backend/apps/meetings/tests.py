"""Meetings: ingest, curation, search, links and the REST surface.

The cases that matter most are the ones in ``UpsertTests`` — a pipeline
re-push undoing someone's curation is the failure this app is designed
around.
"""

from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.tasks.models import Project, StateTransition, Task

from . import services
from .models import Entity, Meeting, MeetingEntity, MeetingLink, Tag
from .query import filter_meetings, search_snippet
from .related import build_graph, related_meetings


def payload(stem="2026-09-16-155009-c896f4", **over):
    data = {
        "stem": stem,
        "title": "Acme pricing call",
        "started_at": "2026-09-16T15:50:09+03:00",
        "duration_seconds": 1800,
        "category": "client",
        "summary": "Walked Acme through the new pricing.",
        "brief_md": "## Decisions\n- Annual plan only",
        "transcript_md": "Ali: the enterprise tier needs SSO before we sign.",
        "entities": [
            {"kind": "person", "name": "Ali K.", "company": "Acme"},
            {"kind": "company", "name": "Acme"},
        ],
        "tags": ["Pricing"],
        "action_items": [{"text": "Send the SSO roadmap", "owner": "Chris"}],
    }
    data.update(over)
    return data


class MeetingsTestCase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("mtg-user")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.project = Project.objects.create(name="Mowafeq", prefix="MOW")
        patcher = mock.patch("apps.meetings.views.broadcast_meeting_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)

    def push(self, **over):
        return self.client.post("/api/meetings/", payload(**over), format="json")


class UpsertTests(MeetingsTestCase):
    def test_create_assigns_key_and_links(self):
        res = self.push(project="mow")
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(res.data["key"], "MTG-001")
        self.assertEqual(res.data["project"]["prefix"], "MOW")
        self.assertEqual(res.data["tags"], ["pricing"])
        self.assertEqual(
            {(e["kind"], e["name"]) for e in res.data["entities"]},
            {("person", "Ali K."), ("company", "Acme")},
        )
        ali = Entity.objects.get(slug="ali-k")
        self.assertEqual(ali.company.name, "Acme")
        self.assertNotIn("brief_html", res.data)
        self.broadcast.assert_called_with("meeting.created", {"key": "MTG-001"})

    def test_repush_is_idempotent(self):
        self.push()
        res = self.push()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Meeting.objects.count(), 1)
        self.assertEqual(MeetingEntity.objects.count(), 2)
        self.assertEqual(len(res.data["action_items"]), 1)
        self.broadcast.assert_called_with("meeting.updated", {"key": "MTG-001"})

    def test_repush_refreshes_pipeline_fields_but_keeps_curation(self):
        key = self.push().data["key"]
        self.client.patch(
            f"/api/meetings/{key}/",
            {"title": "Acme — pricing (renamed)", "category": "sales", "tags": ["deal"]},
            format="json",
        )
        res = self.push(
            title="Pipeline title v2",
            category="internal",
            tags=["noise"],
            transcript_md="v2 transcript",
        )
        self.assertEqual(res.data["transcript_md"], "v2 transcript")
        self.assertEqual(res.data["title"], "Acme — pricing (renamed)")
        self.assertEqual(res.data["category"], "sales")
        # Tags are additive on a re-push, never replaced.
        self.assertEqual(res.data["tags"], ["deal", "noise"])

    def test_overwrite_metadata_opts_in(self):
        self.push()
        res = self.push(title="Forced", tags=["only"], overwrite_metadata=True)
        self.assertEqual(res.data["title"], "Forced")
        self.assertEqual(res.data["tags"], ["only"])

    def test_repush_fills_a_still_empty_project(self):
        self.push()
        res = self.push(project="MOW")
        self.assertEqual(res.data["project"]["prefix"], "MOW")

    def test_repush_never_removes_entities(self):
        self.push()
        res = self.push(entities=[{"kind": "person", "name": "Sara"}])
        self.assertEqual(
            {e["name"] for e in res.data["entities"]}, {"Ali K.", "Acme", "Sara"}
        )

    def test_mention_is_upgraded_to_attendee_not_downgraded(self):
        self.push(entities=[{"kind": "person", "name": "Sara", "role": "mentioned"}])
        self.push(entities=[{"kind": "person", "name": "Sara", "role": "attendee"}])
        link = MeetingEntity.objects.get(entity__name="Sara")
        self.assertEqual(link.role, "attendee")
        self.push(entities=[{"kind": "person", "name": "Sara", "role": "mentioned"}])
        link.refresh_from_db()
        self.assertEqual(link.role, "attendee")

    def test_action_item_state_survives_repush(self):
        data = self.push().data
        item_id = data["action_items"][0]["id"]
        self.client.patch(
            f"/api/meetings/{data['key']}/action-items/{item_id}/",
            {"done": True},
            format="json",
        )
        res = self.push(
            action_items=[
                {"text": "Send the SSO roadmap!", "owner": "Chris A."},
                {"text": "Book a follow-up"},
            ]
        )
        items = {i["text"]: i for i in res.data["action_items"]}
        # Punctuation-only edits hash to the same id, so `done` carries over.
        self.assertTrue(items["Send the SSO roadmap!"]["done"])
        self.assertEqual(items["Send the SSO roadmap!"]["owner"], "Chris A.")
        self.assertFalse(items["Book a follow-up"]["done"])

    def test_acted_on_item_is_kept_when_pipeline_drops_it(self):
        data = self.push().data
        item_id = data["action_items"][0]["id"]
        services.set_action_item_done(Meeting.objects.get(), item_id, True)
        res = self.push(action_items=[{"text": "Something else entirely"}])
        self.assertEqual(len(res.data["action_items"]), 2)

    def test_personal_recordings_are_refused(self):
        res = self.push(route="personal")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Meeting.objects.exists())

    def test_naive_timestamp_is_refused(self):
        res = self.push(started_at="2026-09-16T15:50:09")
        self.assertEqual(res.status_code, 400)
        self.assertIn("started_at", res.data)

    def test_new_meeting_needs_title_and_start(self):
        res = self.client.post("/api/meetings/", {"stem": "x"}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_unknown_project_is_a_400(self):
        self.assertEqual(self.push(project="NOPE").status_code, 400)

    def test_requires_login(self):
        self.assertIn(APIClient().get("/api/meetings/").status_code, (401, 403))


class EntityTests(MeetingsTestCase):
    def test_alias_resolves_to_existing_entity(self):
        ali = services.resolve_entity("person", "Ali K.")
        ali.aliases = ["Ali Khoury"]
        ali.save()
        self.assertEqual(services.resolve_entity("person", "ali khoury"), ali)
        self.assertEqual(services.resolve_entity("person", "ALI K"), ali)
        self.assertEqual(Entity.objects.filter(kind="person").count(), 1)

    def test_same_name_different_kind_are_distinct(self):
        a = services.resolve_entity("person", "Acme")
        b = services.resolve_entity("company", "Acme")
        self.assertNotEqual(a.pk, b.pk)

    def test_merge_repoints_links_and_keeps_pipeline_resolving(self):
        self.push(entities=[{"kind": "person", "name": "Ali"}])
        self.push(
            stem="second",
            entities=[
                {"kind": "person", "name": "Ali", "role": "mentioned"},
                {"kind": "person", "name": "Ali K."},
            ],
        )
        short = Entity.objects.get(slug="ali")
        full = Entity.objects.get(slug="ali-k")
        res = self.client.post(
            f"/api/meeting-entities/{short.pk}/merge/", {"into": full.pk}, format="json"
        )
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data["meeting_count"], 2)
        self.assertIn("Ali", res.data["aliases"])
        self.assertFalse(Entity.objects.filter(pk=short.pk).exists())
        # One link per meeting, and the duplicate kept the stronger role.
        self.assertEqual(MeetingEntity.objects.filter(entity=full).count(), 2)
        self.assertFalse(MeetingEntity.objects.filter(role="mentioned").exists())
        # The next push of the old name lands on the survivor.
        self.push(stem="third", entities=[{"kind": "person", "name": "Ali"}])
        self.assertFalse(Entity.objects.filter(slug="ali").exists())

    def test_merge_across_kinds_is_refused(self):
        person = services.resolve_entity("person", "Acme")
        company = services.resolve_entity("company", "Acme")
        res = self.client.post(
            f"/api/meeting-entities/{person.pk}/merge/",
            {"into": company.pk},
            format="json",
        )
        self.assertEqual(res.status_code, 400)

    def test_list_carries_meeting_counts(self):
        self.push()
        res = self.client.get("/api/meeting-entities/?kind=company")
        self.assertEqual(
            [(e["name"], e["meeting_count"]) for e in res.data["results"]],
            [("Acme", 1)],
        )


class QueryTests(MeetingsTestCase):
    def setUp(self):
        super().setUp()
        self.push(project="MOW")
        self.push(
            stem="internal-1",
            title="Weekly sync",
            started_at="2026-08-03T10:00:00+03:00",
            category="internal",
            summary="",
            brief_md="",
            transcript_md="Abed: the deploy is blocked on migrations.",
            entities=[{"kind": "person", "name": "Abed"}],
            tags=["ops"],
            action_items=[],
        )

    def keys(self, **filters):
        return [m.key for m in filter_meetings(filters)]

    def test_newest_first(self):
        self.assertEqual(self.keys(), ["MTG-001", "MTG-002"])

    def test_filters(self):
        self.assertEqual(self.keys(category="internal"), ["MTG-002"])
        self.assertEqual(self.keys(project="MOW"), ["MTG-001"])
        self.assertEqual(self.keys(project="none"), ["MTG-002"])
        self.assertEqual(self.keys(person="abed"), ["MTG-002"])
        self.assertEqual(self.keys(tag="Pricing"), ["MTG-001"])
        self.assertEqual(self.keys(entity=Entity.objects.get(slug="acme").pk), ["MTG-001"])
        self.assertEqual(self.keys(unknown_key="ignored"), ["MTG-001", "MTG-002"])

    def test_company_filter_includes_its_people(self):
        self.push(
            stem="ali-only",
            title="Coffee with Ali",
            entities=[{"kind": "person", "name": "Ali K."}],
        )
        self.assertEqual(set(self.keys(company="acme")), {"MTG-001", "MTG-003"})

    def test_date_range_is_inclusive_of_the_end_day(self):
        self.assertEqual(self.keys(date_to="2026-08-03"), ["MTG-002"])
        self.assertEqual(self.keys(date_from="2026-08-04"), ["MTG-001"])
        self.assertEqual(
            self.keys(date_from="2026-08-01", date_to="2026-09-30"),
            ["MTG-001", "MTG-002"],
        )

    def test_search_reaches_transcript_entities_and_tags(self):
        self.assertEqual(self.keys(search="sso"), ["MTG-001"])
        self.assertEqual(self.keys(search="abed"), ["MTG-002"])
        self.assertEqual(self.keys(search="ops"), ["MTG-002"])
        self.assertEqual(self.keys(search="nothing-matches"), [])

    def test_joins_do_not_duplicate_rows(self):
        # "a" matches the title, both entities and the tag of MTG-001.
        self.assertEqual(self.keys(search="a").count("MTG-001"), 1)

    def test_snippet_explains_the_match(self):
        meeting = Meeting.objects.get(key="MTG-001")
        self.assertIn("needs SSO before", search_snippet(meeting, "sso"))
        self.assertEqual(search_snippet(meeting, ""), "")

    def test_list_endpoint_is_light_and_carries_snippets(self):
        res = self.client.get("/api/meetings/?search=migrations")
        row = res.data["results"][0]
        self.assertEqual(row["key"], "MTG-002")
        self.assertIn("blocked on migrations", row["snippet"])
        self.assertNotIn("transcript_md", row)

    def test_facets(self):
        res = self.client.get("/api/meetings/facets/")
        self.assertEqual(res.data["total"], 2)
        counts = {c["value"]: c["count"] for c in res.data["categories"]}
        self.assertEqual((counts["client"], counts["internal"], counts["sales"]), (1, 1, 0))
        self.assertEqual({t["name"] for t in res.data["tags"]}, {"pricing", "ops"})


class RelatedAndGraphTests(MeetingsTestCase):
    def setUp(self):
        super().setUp()
        self.push(project="MOW")
        self.push(stem="followup", title="Acme follow-up", tags=[])
        self.push(
            stem="other",
            title="Unrelated",
            entities=[{"kind": "person", "name": "Zed"}],
            tags=[],
        )
        self.a, self.b, self.c = Meeting.objects.order_by("id")

    def test_related_ranks_by_shared_context_with_reasons(self):
        hits = related_meetings(self.a)
        self.assertEqual([h["key"] for h in hits], [self.b.key])
        self.assertEqual(set(hits[0]["reasons"]), {"Ali K.", "Acme"})

    def test_explicit_link_is_pinned_first(self):
        res = self.client.post(
            f"/api/meetings/{self.a.key}/links/",
            {"to": self.c.key, "kind": "follow_up"},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data[0]["key"], self.c.key)
        self.assertEqual(res.data[0]["link_kind"], "follow_up")
        # Linking the other way round is the same link, not a second one.
        self.client.post(
            f"/api/meetings/{self.c.key}/links/", {"to": self.a.key}, format="json"
        )
        self.assertEqual(MeetingLink.objects.count(), 1)
        self.client.delete(
            f"/api/meetings/{self.c.key}/links/", {"to": self.a.key}, format="json"
        )
        self.assertEqual(MeetingLink.objects.count(), 0)

    def test_self_link_is_refused(self):
        res = self.client.post(
            f"/api/meetings/{self.a.key}/links/", {"to": self.a.key}, format="json"
        )
        self.assertEqual(res.status_code, 400)

    def test_graph_shape(self):
        graph = build_graph()
        by_type = {}
        for node in graph["nodes"]:
            by_type.setdefault(node["type"], []).append(node)
        self.assertEqual(len(by_type["meeting"]), 3)
        self.assertEqual({n["label"] for n in by_type["person"]}, {"Ali K.", "Zed"})
        self.assertEqual([n["label"] for n in by_type["company"]], ["Acme"])
        self.assertEqual([n["label"] for n in by_type["project"]], ["Mowafeq"])
        ids = {n["id"] for n in graph["nodes"]}
        for edge in graph["edges"]:
            self.assertIn(edge["source"], ids)
            self.assertIn(edge["target"], ids)
        kinds = [e["kind"] for e in graph["edges"]]
        self.assertEqual(kinds.count("works_at"), 1)
        # No derived meeting↔meeting edges.
        self.assertFalse(
            [e for e in graph["edges"] if e["source"][0] == e["target"][0] == "m"]
        )

    def test_graph_respects_filters_and_toggles(self):
        self.push(
            stem="mention",
            title="Mentions only",
            entities=[{"kind": "company", "name": "Globex", "role": "mentioned"}],
        )
        labels = lambda g: {n["label"] for n in g["nodes"]}  # noqa: E731
        self.assertNotIn("Globex", labels(build_graph()))
        self.assertIn("Globex", labels(build_graph(include_mentioned=True)))
        self.assertNotIn("Mowafeq", labels(build_graph(include_projects=False)))
        scoped = self.client.get("/api/meetings/graph/?person=zed").data
        self.assertEqual(
            [n["label"] for n in scoped["nodes"] if n["type"] == "meeting"],
            ["Unrelated"],
        )

    def test_pulls_in_a_company_no_meeting_tagged(self):
        self.push(
            stem="solo",
            title="Solo",
            entities=[{"kind": "person", "name": "Dana", "company": "Initech"}],
        )
        graph = build_graph({"person": "dana"})
        self.assertIn("Initech", {n["label"] for n in graph["nodes"]})


class ActionItemTaskTests(MeetingsTestCase):
    def setUp(self):
        super().setUp()
        data = self.push(project="MOW").data
        self.key = data["key"]
        self.item_id = data["action_items"][0]["id"]
        self.url = f"/api/meetings/{self.key}/action-items/{self.item_id}/create-task/"

    @mock.patch("apps.meetings.services.notify_task_event")
    @mock.patch("apps.meetings.services.broadcast_task_event")
    def test_creates_a_linked_task_through_the_normal_write_path(self, board, notify):
        res = self.client.post(self.url, {}, format="json")
        self.assertEqual(res.status_code, 201, res.data)
        task = Task.objects.get()
        self.assertEqual(task.title, "Send the SSO roadmap")
        self.assertEqual(task.project, self.project)
        self.assertEqual(task.reporter, self.user)
        self.assertFalse(task.column.is_done)
        self.assertEqual(res.data["action_items"][0]["task_key"], task.key)
        self.assertEqual(res.data["linked_tasks"][0]["key"], task.key)
        self.assertEqual(StateTransition.objects.filter(task=task).count(), 1)
        board.assert_called_once_with(
            self.project.id, "task.created", {"key": task.key, "id": task.id}
        )
        notify.assert_called_once()

    def test_cannot_create_twice(self):
        self.client.post(self.url, {}, format="json")
        self.assertEqual(self.client.post(self.url, {}, format="json").status_code, 400)
        self.assertEqual(Task.objects.count(), 1)

    def test_needs_a_project_when_the_meeting_has_none(self):
        data = self.push(stem="no-project").data
        url = (
            f"/api/meetings/{data['key']}/action-items/"
            f"{data['action_items'][0]['id']}/create-task/"
        )
        self.assertEqual(self.client.post(url, {}, format="json").status_code, 400)
        res = self.client.post(url, {"project": "MOW"}, format="json")
        self.assertEqual(res.status_code, 201, res.data)

    def test_unknown_item_is_a_400(self):
        res = self.client.patch(
            f"/api/meetings/{self.key}/action-items/nope/", {"done": True}, format="json"
        )
        self.assertEqual(res.status_code, 400)

    def test_manual_task_link_and_unlink(self):
        col = self.project.columns.first()
        task = Task.objects.create(
            project=self.project, column=col, title="Existing", reporter=self.user
        )
        url = f"/api/meetings/{self.key}/tasks/"
        res = self.client.post(url, {"task": task.key}, format="json")
        self.assertEqual([t["key"] for t in res.data["linked_tasks"]], [task.key])
        self.client.post(url, {"task": task.key}, format="json")  # idempotent
        res = self.client.delete(url, {"task": task.key}, format="json")
        self.assertEqual(res.data["linked_tasks"], [])

    def test_deleting_the_project_keeps_the_meeting(self):
        self.project.delete()
        self.assertIsNone(Meeting.objects.get(key=self.key).project)


class CurationTests(MeetingsTestCase):
    def test_patch_makes_entities_and_tags_exact(self):
        key = self.push().data["key"]
        res = self.client.patch(
            f"/api/meetings/{key}/",
            {"entities": [{"kind": "person", "name": "Sara"}], "tags": []},
            format="json",
        )
        self.assertEqual([e["name"] for e in res.data["entities"]], ["Sara"])
        self.assertEqual(res.data["tags"], [])
        # Entities and tags outlive the link — they're shared nodes.
        self.assertTrue(Entity.objects.filter(slug="acme").exists())
        self.assertTrue(Tag.objects.filter(name="pricing").exists())

    def test_put_is_not_offered(self):
        key = self.push().data["key"]
        self.assertEqual(
            self.client.put(f"/api/meetings/{key}/", {}, format="json").status_code, 405
        )

    def test_delete_broadcasts(self):
        key = self.push().data["key"]
        self.assertEqual(self.client.delete(f"/api/meetings/{key}/").status_code, 204)
        self.broadcast.assert_called_with("meeting.deleted", {"key": key})


class BroadcastBridgeTests(TestCase):
    def test_internal_bridge_routes_the_meetings_scope(self):
        with self.settings(CYT_BROADCAST_SECRET="s3cret"), mock.patch(
            "apps.meetings.broadcast._broadcast_local"
        ) as local:
            res = APIClient().post(
                "/api/internal/broadcast/",
                {"scope": "meetings", "type": "meeting.updated", "payload": {"key": "MTG-001"}},
                format="json",
                HTTP_X_CYT_BROADCAST_SECRET="s3cret",
                REMOTE_ADDR="127.0.0.1",
            )
        self.assertEqual(res.status_code, 200)
        local.assert_called_once_with("meeting.updated", {"key": "MTG-001"})
