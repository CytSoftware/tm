"""Drive layout and the Google-Drive-style endpoints (B2 mocked).

    uv run python manage.py test apps.drive
"""

from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.mcp_server import tools
from apps.tasks.models import Project

from .layout import check_folder, drive_path, is_hidden
from .models import DriveFile

User = get_user_model()
EMPTY = {"prefix": "", "folders": [], "files": [], "next_token": None}


class DriveLayoutTests(TestCase):
    def setUp(self):
        self.mow = Project.objects.create(name="mowafeq", prefix="MOW")

    def test_path_is_project_then_category(self):
        self.assertEqual(drive_path(self.mow, "sales", "deck.pdf", subfolder="Decks"),
                         "mowafeq/sales/decks/deck.pdf")
        self.assertEqual(drive_path(self.mow, "clients", "../x/contract.pdf", client="Changda CSMEDI"),
                         "mowafeq/clients/changda-csmedi/contract.pdf")
        with self.assertRaisesMessage(ValueError, "needs `client`"):
            drive_path(self.mow, "clients", "x.pdf")

    def test_top_two_levels_are_locked(self):
        self.assertEqual(check_folder("mowafeq/sales/decks"), "mowafeq/sales/decks/")
        self.assertEqual(check_folder("to-be-organized/"), "to-be-organized/")
        for bad in ("", "mowafeq/", "mowafeq/research/", "nope/sales/", "sources/x/", "../x"):
            with self.assertRaises(ValueError, msg=bad):
                check_folder(bad)

    def test_project_rename_keeps_its_folder(self):
        self.mow.name = "Mowafeq Platform"
        self.mow.save()
        self.assertEqual(check_folder("mowafeq/sales/"), "mowafeq/sales/")

    def test_system_folders_and_junk_are_hidden(self):
        for key in ("meetings/x.md", "sources/a.pdf", "backups/x", "a/.DS_Store",
                    "general/clients/c/~$ doc.docx", "general/archive/logo.blend1"):
            self.assertTrue(is_hidden(key), key)
        self.assertFalse(is_hidden("mowafeq/sales/deck.pdf"))

    def test_mcp_upload_files_by_layout_or_inbox(self):
        with mock.patch("apps.drive.b2.put_bytes", side_effect=lambda k, d, c: {"key": k}) as put:
            self.assertEqual(tools.drive_upload("notes.md", content="x")["key"], "to-be-organized/notes.md")
            self.assertEqual(tools.drive_upload("d.pdf", project="MOW", category="sales", content="x")["key"],
                             "mowafeq/sales/d.pdf")
            with self.assertRaisesMessage(ValueError, "both `project` and `category`"):
                tools.drive_upload("x.md", project="MOW", content="x")
            self.assertEqual(put.call_count, 2)


@mock.patch("apps.drive.b2.is_configured", return_value=True)
class DriveEndpointTests(TestCase):
    def setUp(self):
        Project.objects.create(name="mowafeq", prefix="MOW")
        self.staff = User.objects.create_user("boss", password="x", is_staff=True)
        self.emp = User.objects.create_user("emp", password="x")

    def test_root_shows_projects_and_inbox_but_not_system(self, _):
        self.client.force_login(self.staff)
        def listed(*a, **k):
            return {**EMPTY, "folders": ["meetings/", "sources/", "mowafeq/"]}

        with mock.patch("apps.drive.b2.list_objects", side_effect=listed):
            folders = self.client.get("/api/drive/objects/").json()["folders"]
            self.assertEqual(folders, ["mowafeq/", "to-be-organized/"])
            with_system = self.client.get("/api/drive/objects/?system=1").json()["folders"]
            self.assertIn("meetings/", with_system)
        with mock.patch("apps.drive.b2.list_objects", return_value={**EMPTY, "prefix": "mowafeq/"}):
            data = self.client.get("/api/drive/objects/?prefix=mowafeq/").json()
            self.assertIn("mowafeq/sales/", data["folders"])
            self.assertIn("mowafeq/sales/", data["empty"])

    def test_folder_create_is_locked_above_categories(self, _):
        self.client.force_login(self.staff)
        with mock.patch("apps.drive.b2.create_folder", side_effect=lambda f: {"folder": f}) as mk:
            ok = self.client.post("/api/drive/folders/", {"parent": "mowafeq/sales/", "name": "Q4 Decks"})
            self.assertEqual(ok.status_code, 201)
            mk.assert_called_once_with("mowafeq/sales/q4-decks/")
            self.assertEqual(self.client.post("/api/drive/folders/", {"parent": "mowafeq/", "name": "x"}).status_code, 400)

    def test_employee_moves_and_creates_only_where_shared(self, _):
        DriveFile.objects.create(key="mowafeq/sales/shared/").shared_with.add(self.emp)
        self.client.force_login(self.emp)
        with mock.patch("apps.drive.b2.create_folder", side_effect=lambda f: {"folder": f}):
            self.assertEqual(self.client.post("/api/drive/folders/", {"parent": "mowafeq/sales/shared/", "name": "a"}).status_code, 201)
            self.assertEqual(self.client.post("/api/drive/folders/", {"parent": "mowafeq/sales/", "name": "b"}).status_code, 404)
        self.assertEqual(self.client.post("/api/drive/move/", {"key": "mowafeq/sales/other.pdf", "to": "mowafeq/sales/shared/"}).status_code, 404)

    def test_sharing_is_staff_only_and_non_staff_only(self, _):
        self.client.force_login(self.emp)
        self.assertEqual(self.client.get("/api/drive/shares/?key=mowafeq/sales/x.pdf").status_code, 403)
        self.client.force_login(self.staff)
        resp = self.client.put("/api/drive/shares/", {"key": "mowafeq/sales/x.pdf", "user_ids": [self.emp.pk, self.staff.pk]},
                               content_type="application/json")
        self.assertEqual(resp.json()["shared_with"], [self.emp.pk])
