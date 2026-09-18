"""The meeting MCP tools.

The ingest rules themselves (what a re-push may and may not overwrite) are
covered in ``apps/meetings/tests.py`` — the tools share that code. These tests
cover what is specific to MCP: the flat argument shape, key-or-stem and
name-or-id references, readable errors, attribution and scope enforcement
through the real ``call_tool`` entry point, and broadcasts.
"""

from __future__ import annotations

import json
from unittest import mock

from asgiref.sync import async_to_sync
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.meetings import mcp_tools
from apps.meetings.models import Entity, Meeting, MeetingLink
from apps.tasks.models import Project, StateTransition, Task

from .auth import SCOPE_SCOPES_KEY, SCOPE_USER_KEY
from .tests import fake_request_ctx, reset_request_ctx

STEM = "2026-09-16-155009-c896f4"


def push(stem=STEM, **over):
    args = {
        "title": "Acme pricing call",
        "started_at": "2026-09-16T15:50:09+03:00",
        "category": "client",
        "summary": "Walked Acme through pricing.",
        "brief_md": "## Decisions\n- Annual plan only",
        "transcript_md": "Ali: the enterprise tier needs SSO before we sign.",
        "people": [{"name": "Ali K.", "company": "Acme"}, "Chris Akoury"],
        "companies": ["Acme"],
        "mentioned_companies": ["Globex"],
        "tags": ["Pricing"],
        "action_items": ["Send the SSO roadmap", {"text": "Book follow-up", "owner": "Chris"}],
    }
    args.update(over)
    return mcp_tools.upsert_meeting(stem, **args)


@override_settings(FRONTEND_URL="https://tm.example.com")
class MeetingToolTestCase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("pipeline")
        self.project = Project.objects.create(name="Mowafeq", prefix="MOW")
        patcher = mock.patch("apps.meetings.mcp_tools.broadcast_meeting_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)


class UpsertToolTests(MeetingToolTestCase):
    def test_flat_arguments_become_a_linked_meeting(self):
        result = push(project="MOW", mcp_user=self.user)
        self.assertTrue(result["created"])
        self.assertEqual(result["key"], "MTG-001")
        self.assertEqual(result["url"], "https://tm.example.com/meetings?m=MTG-001")
        self.assertEqual(result["project"]["prefix"], "MOW")
        roles = {(e["kind"], e["name"]): e["role"] for e in result["entities"]}
        self.assertEqual(
            roles,
            {
                ("person", "Ali K."): "attendee",
                ("person", "Chris Akoury"): "attendee",
                ("company", "Acme"): "attendee",
                ("company", "Globex"): "mentioned",
            },
        )
        self.assertEqual(Entity.objects.get(slug="ali-k").company.name, "Acme")
        self.assertEqual([i["text"] for i in result["action_items"]], ["Send the SSO roadmap", "Book follow-up"])
        self.assertEqual(Meeting.objects.get().created_by, self.user)
        self.broadcast.assert_called_with("meeting.created", {"key": "MTG-001"})

    def test_reply_is_small_and_json_serialisable(self):
        result = push()
        json.dumps(result)  # FastMCP serialises the return value
        for heavy in ("transcript_md", "brief_md", "brief_html", "source_meta"):
            self.assertNotIn(heavy, result)
        self.assertEqual(result["transcript_chars"], len("Ali: the enterprise tier needs SSO before we sign."))

    def test_reports_entities_it_created_so_duplicates_are_visible(self):
        first = push()
        self.assertEqual(
            {e["name"] for e in first["new_entities"]},
            {"Ali K.", "Chris Akoury", "Acme", "Globex"},
        )
        again = push(people=["Ali K.", "Ali"])
        self.assertFalse(again["created"])
        self.assertEqual([e["name"] for e in again["new_entities"]], ["Ali"])
        self.broadcast.assert_called_with("meeting.updated", {"key": "MTG-001"})

    def test_omitted_arguments_leave_stored_values_alone(self):
        push()
        mcp_tools.upsert_meeting(STEM, transcript_md="v2")
        meeting = Meeting.objects.get()
        self.assertEqual(meeting.transcript_md, "v2")
        self.assertEqual(meeting.brief_md, "## Decisions\n- Annual plan only")
        self.assertEqual(meeting.entities.count(), 4)
        self.assertEqual(len(meeting.action_items), 2)

    def test_errors_are_one_readable_line(self):
        with self.assertRaisesMessage(ValueError, "started_at: Timestamp must include a UTC offset"):
            push(started_at="2026-09-16T15:50:09")
        with self.assertRaisesMessage(ValueError, "category:"):
            push(category="standup")
        with self.assertRaisesMessage(ValueError, "Only work recordings"):
            push(route="personal")
        with self.assertRaisesMessage(ValueError, "title and started_at are required"):
            mcp_tools.upsert_meeting("new-stem", transcript_md="x")
        with self.assertRaisesMessage(ValueError, "Project 'NOPE' not found"):
            push(project="NOPE")
        self.assertFalse(Meeting.objects.exists())


class ReadToolTests(MeetingToolTestCase):
    def setUp(self):
        super().setUp()
        push(project="MOW")
        push(
            "internal-1",
            title="Weekly sync",
            started_at="2026-08-03T10:00:00+03:00",
            category="internal",
            transcript_md="Abed: the deploy is blocked on migrations.",
            people=["Abed Itani", "Chris Akoury"],
            companies=[],
            mentioned_companies=[],
            tags=["ops"],
            action_items=[],
        )

    def test_get_by_key_or_stem_without_transcript_by_default(self):
        by_key = mcp_tools.get_meeting("mtg-001")
        by_stem = mcp_tools.get_meeting(STEM)
        self.assertEqual(by_key["key"], by_stem["key"])
        self.assertIn("brief_md", by_key)
        self.assertNotIn("transcript_md", by_key)
        self.assertGreater(by_key["transcript_chars"], 0)
        full = mcp_tools.get_meeting("MTG-001", include_transcript=True)
        self.assertIn("SSO", full["transcript_md"])
        with self.assertRaisesMessage(ValueError, "not found"):
            mcp_tools.get_meeting("MTG-999")

    def test_list_filters_take_names_not_slugs(self):
        keys = lambda **f: [m["key"] for m in mcp_tools.list_meetings(**f)]  # noqa: E731
        self.assertEqual(keys(), ["MTG-001", "MTG-002"])
        self.assertEqual(keys(person="Abed Itani"), ["MTG-002"])
        self.assertEqual(keys(company="ACME"), ["MTG-001"])
        self.assertEqual(keys(person="Chris Akoury"), ["MTG-001", "MTG-002"])
        self.assertEqual(keys(project="MOW", category="client"), ["MTG-001"])
        self.assertEqual(keys(date_to="2026-08-31"), ["MTG-002"])
        self.assertEqual(keys(limit=1), ["MTG-001"])
        row = mcp_tools.list_meetings()[0]
        self.assertNotIn("transcript_md", row)
        self.assertNotIn("snippet", row)
        json.dumps(mcp_tools.list_meetings())

    def test_search_returns_the_reason_it_matched(self):
        hits = mcp_tools.search_meetings("migrations")
        self.assertEqual([h["key"] for h in hits], ["MTG-002"])
        self.assertIn("blocked on migrations", hits[0]["snippet"])
        self.assertEqual(mcp_tools.search_meetings("sso", category="internal"), [])
        with self.assertRaisesMessage(ValueError, "query is required"):
            mcp_tools.search_meetings("  ")

    def test_related_and_entities(self):
        related = mcp_tools.get_related_meetings("MTG-001")
        self.assertEqual([r["key"] for r in related], ["MTG-002"])
        self.assertEqual(related[0]["reasons"], ["Chris Akoury"])
        json.dumps(related)
        people = mcp_tools.list_meeting_entities(kind="person")
        self.assertEqual(people[0]["name"], "Chris Akoury")
        self.assertEqual(people[0]["meeting_count"], 2)
        self.assertEqual(
            [e["name"] for e in mcp_tools.list_meeting_entities(search="acm")], ["Acme"]
        )


class CurationToolTests(MeetingToolTestCase):
    def setUp(self):
        super().setUp()
        push(project="MOW")

    def test_update_is_exact_where_upsert_is_additive(self):
        result = mcp_tools.update_meeting(
            STEM, title="Renamed", category="sales", tags=["deal"], people=["Sara"]
        )
        self.assertEqual(result["title"], "Renamed")
        self.assertEqual(result["tags"], ["deal"])
        self.assertEqual([e["name"] for e in result["entities"]], ["Sara"])
        # …and the pipeline's next push doesn't undo any of it.
        again = push()
        self.assertEqual(again["title"], "Renamed")
        self.assertEqual(again["category"], "sales")
        self.broadcast.assert_any_call("meeting.updated", {"key": "MTG-001"})

    def test_update_can_clear_the_project_and_rejects_a_no_op(self):
        self.assertIsNone(mcp_tools.update_meeting("MTG-001", clear_project=True)["project"])
        with self.assertRaisesMessage(ValueError, "Nothing to update"):
            mcp_tools.update_meeting("MTG-001")

    def test_action_item_to_task_is_attributed_and_logged_as_mcp(self):
        item_id = mcp_tools.get_meeting("MTG-001")["action_items"][0]["id"]
        done = mcp_tools.set_meeting_action_item("MTG-001", item_id, True)
        self.assertTrue(done["action_items"][0]["done"])

        with mock.patch("apps.meetings.services.broadcast_task_event") as board:
            result = mcp_tools.create_task_from_meeting_action_item(
                "MTG-001", item_id, mcp_user=self.user
            )
        task = Task.objects.get()
        self.assertEqual(result["task"]["key"], task.key)
        self.assertEqual(task.reporter, self.user)
        self.assertEqual(task.project, self.project)
        self.assertEqual(StateTransition.objects.get(task=task).source, "mcp")
        board.assert_called_once()
        detail = mcp_tools.get_meeting("MTG-001")
        self.assertEqual(detail["action_items"][0]["task_key"], task.key)
        self.assertEqual([t["key"] for t in detail["linked_tasks"]], [task.key])
        with self.assertRaisesMessage(ValueError, "Already linked"):
            mcp_tools.create_task_from_meeting_action_item("MTG-001", item_id, mcp_user=self.user)

    def test_link_and_unlink_a_task(self):
        task = Task.objects.create(
            project=self.project,
            column=self.project.columns.first(),
            title="Existing",
            reporter=self.user,
        )
        linked = mcp_tools.link_meeting_task("MTG-001", task.key.lower())
        self.assertEqual([t["key"] for t in linked["linked_tasks"]], [task.key])
        mcp_tools.link_meeting_task("MTG-001", task.key)  # idempotent
        self.assertEqual(
            mcp_tools.link_meeting_task("MTG-001", task.key, unlink=True)["linked_tasks"], []
        )
        with self.assertRaisesMessage(ValueError, "Task 'NOPE-1' not found"):
            mcp_tools.link_meeting_task("MTG-001", "NOPE-1")

    def test_link_meetings(self):
        push("second", title="Unrelated", people=["Zed"], companies=[], mentioned_companies=[], tags=[])
        related = mcp_tools.link_meetings("second", STEM, kind="follow_up")
        self.assertEqual(related[0]["key"], "MTG-001")
        self.assertEqual(related[0]["link_kind"], "follow_up")
        mcp_tools.link_meetings(STEM, "second")  # same pair, other way round
        self.assertEqual(MeetingLink.objects.count(), 1)
        with self.assertRaisesMessage(ValueError, "can't link to itself"):
            mcp_tools.link_meetings(STEM, "MTG-001")
        with self.assertRaisesMessage(ValueError, "Unknown link kind"):
            mcp_tools.link_meetings("second", STEM, kind="sequel")
        mcp_tools.link_meetings(STEM, "second", unlink=True)
        self.assertEqual(MeetingLink.objects.count(), 0)

    def test_delete(self):
        self.assertEqual(mcp_tools.delete_meeting(STEM)["deleted"], "MTG-001")
        self.assertFalse(Meeting.objects.exists())
        self.assertTrue(Entity.objects.filter(slug="acme").exists())
        self.broadcast.assert_called_with("meeting.deleted", {"key": "MTG-001"})


class EntityToolTests(MeetingToolTestCase):
    def test_rename_keeps_both_names_resolving(self):
        push(people=["Ali"], companies=[], mentioned_companies=[])
        renamed = mcp_tools.update_meeting_entity("Ali", name="Ali Khoury", wiki_slug="entities/people/ali-khoury")
        self.assertEqual(renamed["slug"], "ali-khoury")
        self.assertEqual(renamed["aliases"], ["Ali"])
        push("second", people=["Ali"], companies=[], mentioned_companies=[])
        push("third", people=["ali khoury"], companies=[], mentioned_companies=[])
        self.assertEqual(Entity.objects.filter(kind="person").count(), 1)
        self.broadcast.assert_any_call("entity.updated", {"id": renamed["id"]})

    def test_rename_onto_an_existing_entity_points_at_merge(self):
        push(people=["Ali", "Ali K."], companies=[], mentioned_companies=[])
        with self.assertRaisesMessage(ValueError, "use merge_meeting_entities"):
            mcp_tools.update_meeting_entity("Ali", name="Ali K.")

    def test_merge_by_name(self):
        push(people=["Ali"], companies=[], mentioned_companies=[])
        push("second", people=["Ali K."], companies=[], mentioned_companies=[])
        merged = mcp_tools.merge_meeting_entities("Ali", "Ali K.")
        self.assertEqual(merged["name"], "Ali K.")
        self.assertEqual(merged["meeting_count"], 2)
        self.assertIn("Ali", merged["aliases"])
        self.assertFalse(Entity.objects.filter(slug="ali").exists())

    def test_ambiguous_name_asks_for_a_kind(self):
        push(people=["Acme"], companies=["Acme"], mentioned_companies=[])
        with self.assertRaisesMessage(ValueError, "pass kind="):
            mcp_tools.update_meeting_entity("Acme", wiki_slug="x")
        updated = mcp_tools.update_meeting_entity("Acme", kind="company", wiki_slug="entities/companies/acme")
        self.assertEqual(updated["kind"], "company")

    def test_employer(self):
        push(people=["Dana"], companies=[], mentioned_companies=[])
        self.assertEqual(mcp_tools.update_meeting_entity("Dana", company="Initech")["company_name"], "Initech")
        self.assertIsNone(mcp_tools.update_meeting_entity("Dana", company="")["company"])
        with self.assertRaisesMessage(ValueError, "Only a person"):
            mcp_tools.update_meeting_entity("Initech", company="Acme")


class McpEntryPointTests(MeetingToolTestCase):
    """Through ``mcp.call_tool`` — the path a real client takes."""

    def setUp(self):
        super().setUp()
        self._ctx = None

    def tearDown(self):
        if self._ctx is not None:
            reset_request_ctx(self._ctx)

    def _as(self, user, scopes):
        self._ctx = fake_request_ctx({SCOPE_USER_KEY: user, SCOPE_SCOPES_KEY: scopes})

    def _call(self, name, **arguments):
        from .server import mcp

        return async_to_sync(mcp.call_tool)(name, arguments)

    def test_every_meeting_tool_is_classified(self):
        from .server import READ_ONLY_TOOLS, mcp

        tools = {n for n in mcp._tool_manager._tools if "meeting" in n}
        self.assertEqual(
            tools & READ_ONLY_TOOLS,
            {
                "get_meeting",
                "get_related_meetings",
                "list_meeting_entities",
                "list_meetings",
                "search_meetings",
            },
        )
        self.assertEqual(len(tools), 14)

    def test_read_only_credential_can_read_but_not_push(self):
        push()
        self._as(self.user, ["read"])
        self._call("list_meetings")
        self._call("get_meeting", meeting="MTG-001")
        for name, args in (
            ("upsert_meeting", {"stem": "x"}),
            ("delete_meeting", {"meeting": "MTG-001"}),
            ("merge_meeting_entities", {"source": "a", "into": "b"}),
        ):
            with self.assertRaisesMessage(Exception, "read-only"):
                self._call(name, **args)
        self.assertEqual(Meeting.objects.count(), 1)

    def test_push_is_attributed_to_the_requests_user(self):
        self._as(self.user, ["read", "write"])
        self._call(
            "upsert_meeting",
            stem=STEM,
            title="Via MCP",
            started_at="2026-09-16T15:50:09+03:00",
            people=["Ali K."],
        )
        meeting = Meeting.objects.get()
        self.assertEqual(meeting.created_by, self.user)
        self.assertEqual(meeting.title, "Via MCP")

    def test_instructions_tell_the_pipeline_the_rules(self):
        from .server import _SERVER_INSTRUCTIONS

        for phrase in ("upsert_meeting", "UTC offset", "brief_md", "list_meeting_entities"):
            self.assertIn(phrase, _SERVER_INSTRUCTIONS)
