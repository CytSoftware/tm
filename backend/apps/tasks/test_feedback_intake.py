"""Feedback intake: PAT auth on REST, any-type uploads, media serving with
Range and safe dispositions, and ``POST /api/external/tasks/``.

    uv run python manage.py test apps.tasks.test_feedback_intake
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from apps.mcp_server.models import McpAccessToken, generate_mcp_token

from .models import Label, Project, Task

User = get_user_model()


def make_pat(user, scopes=("read", "write")):
    plaintext, prefix, token_hash = generate_mcp_token()
    token = McpAccessToken.objects.create(
        user=user, name="bot", token_prefix=prefix, token_hash=token_hash, scopes=list(scopes)
    )
    return plaintext, token


class TempMediaMixin:
    def setUp(self):
        super().setUp()
        self.media_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media_root, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=self.media_root)
        override.enable()
        self.addCleanup(override.disable)


@override_settings(BACKEND_PUBLIC_URL="https://tm-api.example.com")
class UploadTests(TempMediaMixin, TestCase):
    url = "/api/uploads/"

    def setUp(self):
        super().setUp()
        # Non-staff on purpose: the feedback bot should not need staff.
        self.bot = User.objects.create_user("feedback-bot", password="x")
        self.token, self.pat = make_pat(self.bot)

    def bearer(self, token=None):
        return {"HTTP_AUTHORIZATION": f"Bearer {token or self.token}"}

    def multipart(self, name, content, ctype, **extra):
        return self.client.post(
            self.url, {"file": SimpleUploadedFile(name, content, content_type=ctype)}, **extra
        )

    def raw(self, name, content, ctype, **extra):
        return self.client.post(
            self.url,
            data=content,
            content_type=ctype,
            HTTP_CONTENT_DISPOSITION=f'attachment; filename="{name}"',
            **extra,
        )

    def test_pat_upload(self):
        res = self.multipart("shot.png", b"\x89PNG data", "image/png", **self.bearer())
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual(body["name"], "shot.png")
        self.assertEqual(body["size"], 9)
        self.assertEqual(body["content_type"], "image/png")
        prefix = f"https://tm-api.example.com/media/uploads/{self.bot.id}/"
        self.assertTrue(body["url"].startswith(prefix), body["url"])
        self.assertTrue(body["url"].endswith(".png"))
        stored = Path(self.media_root, body["url"].removeprefix("https://tm-api.example.com/media/"))
        self.assertEqual(stored.read_bytes(), b"\x89PNG data")

    def test_no_auth_is_refused(self):
        res = self.multipart("a.png", b"x", "image/png")
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res["WWW-Authenticate"], "Bearer")

    def test_read_only_pat_is_refused(self):
        token, _ = make_pat(self.bot, scopes=("read",))
        res = self.multipart("a.png", b"x", "image/png", **self.bearer(token))
        self.assertEqual(res.status_code, 401)

    def test_revoked_pat_is_refused(self):
        self.pat.revoke()
        res = self.multipart("a.png", b"x", "image/png", **self.bearer())
        self.assertEqual(res.status_code, 401)

    def test_session_still_works(self):
        self.client.force_login(self.bot)
        res = self.multipart("a.png", b"x", "image/png")
        self.assertEqual(res.status_code, 201, res.content)

    def test_any_type_is_accepted(self):
        for name, ctype in (
            ("report.pdf", "application/pdf"),
            ("rec.webm", "video/webm"),
            ("page.html", "text/html"),
        ):
            res = self.multipart(name, b"content", ctype, **self.bearer())
            self.assertEqual(res.status_code, 201, (name, res.content))
            self.assertEqual(res.json()["content_type"], ctype)
            self.assertTrue(res.json()["url"].endswith("." + name.rsplit(".", 1)[1]))

    def test_client_filename_never_reaches_the_path(self):
        res = self.multipart("../../evil.p h p", b"x", "text/plain", **self.bearer())
        self.assertEqual(res.status_code, 201, res.content)
        self.assertRegex(res.json()["url"], rf"/media/uploads/{self.bot.id}/[0-9a-f]{{32}}\.bin$")

    def test_empty_file_is_refused(self):
        res = self.multipart("a.png", b"", "image/png", **self.bearer())
        self.assertEqual(res.status_code, 400)
        res = self.raw("a.webm", b"", "video/webm", **self.bearer())
        self.assertEqual(res.status_code, 400)

    def test_raw_body_upload_bigger_than_data_upload_max_memory_size(self):
        from django.conf import settings

        content = b"\x1a" * (settings.DATA_UPLOAD_MAX_MEMORY_SIZE + 1024 * 1024)
        res = self.raw("recording.webm", content, "video/webm", **self.bearer())
        self.assertEqual(res.status_code, 201, res.content[:500])
        body = res.json()
        self.assertEqual(body["size"], len(content))
        self.assertEqual(body["name"], "recording.webm")
        self.assertEqual(body["content_type"], "video/webm")
        stored = Path(self.media_root, body["url"].split("/media/", 1)[1])
        self.assertEqual(stored.stat().st_size, len(content))

    def test_raw_body_accepts_rfc5987_filename(self):
        res = self.client.post(
            self.url,
            data=b"%PDF",
            content_type="application/pdf",
            HTTP_CONTENT_DISPOSITION="attachment; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf",
            **self.bearer(),
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["name"], "تقرير.pdf")

    @override_settings(UPLOAD_MAX_BYTES=1024)
    def test_over_cap_is_refused(self):
        res = self.raw("big.webm", b"x" * 2048, "video/webm", **self.bearer())
        self.assertEqual(res.status_code, 413)
        res = self.multipart("big.webm", b"x" * 2048, "video/webm", **self.bearer())
        self.assertEqual(res.status_code, 413)
        self.assertFalse(any(Path(self.media_root).rglob("*.webm")))


class MediaServingTests(TempMediaMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.content = bytes(range(256)) * 4  # 1024 bytes
        base = Path(self.media_root, "uploads", "1")
        base.mkdir(parents=True)
        for name in ("clip.webm", "shot.png", "page.html", "logo.svg"):
            (base / name).write_bytes(self.content)

    async def get(self, path, **headers):
        res = await self.async_client.get(f"/media/uploads/1/{path}", headers=headers)
        body = b""
        if res.status_code in (200, 206):
            body = b"".join([chunk async for chunk in res.streaming_content])
        return res, body

    async def test_full_file(self):
        res, body = await self.get("clip.webm")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(body, self.content)
        self.assertEqual(res["Accept-Ranges"], "bytes")
        self.assertEqual(res["Content-Length"], "1024")
        self.assertEqual(res["Content-Type"], "video/webm")
        self.assertEqual(res["X-Content-Type-Options"], "nosniff")
        self.assertTrue(res["Content-Disposition"].startswith("inline"))

    async def test_range(self):
        res, body = await self.get("clip.webm", Range="bytes=100-199")
        self.assertEqual(res.status_code, 206)
        self.assertEqual(body, self.content[100:200])
        self.assertEqual(res["Content-Range"], "bytes 100-199/1024")
        self.assertEqual(res["Content-Length"], "100")

        res, body = await self.get("clip.webm", Range="bytes=1000-")
        self.assertEqual(res.status_code, 206)
        self.assertEqual(body, self.content[1000:])
        self.assertEqual(res["Content-Range"], "bytes 1000-1023/1024")

        res, body = await self.get("clip.webm", Range="bytes=-24")
        self.assertEqual(res.status_code, 206)
        self.assertEqual(body, self.content[-24:])

        res, body = await self.get("clip.webm", Range="bytes=0-99999")
        self.assertEqual(res.status_code, 206)
        self.assertEqual(body, self.content)

    async def test_unsatisfiable_range(self):
        res, _ = await self.get("clip.webm", Range="bytes=5000-")
        self.assertEqual(res.status_code, 416)
        self.assertEqual(res["Content-Range"], "bytes */1024")

    async def test_html_is_an_attachment(self):
        res, _ = await self.get("page.html")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res["Content-Disposition"].startswith("attachment"))
        self.assertEqual(res["X-Content-Type-Options"], "nosniff")

    async def test_png_is_inline(self):
        res, _ = await self.get("shot.png")
        self.assertTrue(res["Content-Disposition"].startswith("inline"))
        self.assertFalse(res.has_header("Content-Security-Policy"))

    async def test_svg_is_sandboxed(self):
        res, _ = await self.get("logo.svg")
        self.assertTrue(res["Content-Disposition"].startswith("inline"))
        self.assertEqual(res["Content-Security-Policy"], "sandbox")

    async def test_traversal_and_missing(self):
        for path in ("../../../etc/passwd", "%2e%2e/%2e%2e/etc/passwd", "nope.png", ""):
            res = await self.async_client.get(f"/media/uploads/1/{path}")
            self.assertEqual(res.status_code, 404, path)
        res = await self.async_client.get("/media/uploads/")
        self.assertEqual(res.status_code, 404)

    async def test_if_modified_since(self):
        res, _ = await self.get("shot.png")
        res2 = await self.async_client.get(
            "/media/uploads/1/shot.png", headers={"If-Modified-Since": res["Last-Modified"]}
        )
        self.assertEqual(res2.status_code, 304)


class ExternalTaskTests(TestCase):
    url = "/api/external/tasks/"

    def setUp(self):
        self.mow = Project.objects.create(name="Mowafeq", prefix="MOW")
        self.other = Project.objects.create(name="Other", prefix="OTH")
        self.chris = User.objects.create_user("chris", password="x", is_staff=True)
        # A plain member of MOW, not staff: least privilege for the bot.
        self.bot = User.objects.create_user("feedback-bot", password="x")
        self.mow.members.add(self.bot)
        self.token, _ = make_pat(self.bot)
        Label.objects.create(project=self.mow, name="Feedback")

    def post(self, body, token=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token or self.token}"} if token != "" else {}
        return self.client.post(self.url, body, content_type="application/json", **headers)

    def payload(self, **overrides):
        body = {
            "project": "MOW",
            "title": "[Feedback] Bug: the button does nothing",
            "description": "It broke.\n\n![shot.png](https://tm-api.example.com/media/x.png)",
            "column": "Todo",
            "labels": ["feedback", "bug"],
            "assignees": ["chris"],
            "priority": "P2",
        }
        body.update(overrides)
        return body

    def test_creates_in_the_named_column_with_labels_and_assignees(self):
        res = self.post(self.payload())
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        task = Task.objects.get(key=body["key"])
        self.assertEqual(body["id"], task.id)
        self.assertTrue(body["key"].startswith("MOW-"))
        self.assertTrue(body["url"].endswith(f"/board?task={task.key}"))
        self.assertEqual(task.column.name, "Todo")
        self.assertEqual(task.priority, "P2")
        self.assertEqual(task.reporter, self.bot)
        self.assertEqual(task.description, self.payload()["description"])
        self.assertEqual(sorted(task.labels.values_list("name", flat=True)), ["Feedback", "bug"])
        self.assertEqual(list(task.assignees.values_list("username", flat=True)), ["chris"])
        # "feedback" matched the existing "Feedback"; only "bug" was created,
        # scoped to the project.
        self.assertEqual(Label.objects.filter(name__iexact="feedback").count(), 1)
        self.assertEqual(Label.objects.get(name="bug").project, self.mow)

    def test_only_project_and_title_are_required(self):
        res = self.post({"project": "MOW", "title": "Hi"})
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self.post({"project": "MOW"}).status_code, 400)

    def test_unknown_references_are_400(self):
        cases = {
            "project": self.payload(project="NOPE"),
            "column": self.payload(column="Nowhere"),
            "assignee": self.payload(assignees=["ghost"]),
            "priority": self.payload(priority="P9"),
        }
        for what, body in cases.items():
            res = self.post(body)
            self.assertEqual(res.status_code, 400, (what, res.content))
            self.assertIn("detail", res.json())
        self.assertFalse(Task.objects.exists())
        # A failed request must not leave half its labels behind.
        self.assertFalse(Label.objects.filter(name="bug").exists())

    def test_non_member_project_reads_as_unknown(self):
        res = self.post(self.payload(project="OTH"))
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Task.objects.exists())

    def test_no_auth_is_401(self):
        self.assertEqual(self.post(self.payload(), token="").status_code, 401)

    def test_read_only_token_is_401(self):
        token, _ = make_pat(self.bot, scopes=("read",))
        self.assertEqual(self.post(self.payload(), token=token).status_code, 401)

    def test_non_staff_session_member_can_create(self):
        self.client.force_login(self.bot)
        res = self.client.post(self.url, self.payload(), content_type="application/json")
        self.assertEqual(res.status_code, 201, res.content)
        # The endpoint is create-only for them; tasks stay unreadable.
        self.assertEqual(self.client.get("/api/tasks/").status_code, 403)
