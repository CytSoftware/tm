"""DRF endpoints for the Drive — a Backblaze B2 file browser.

B2 is the source of truth for what exists; ``DriveFile`` rows only decide what
a non-staff user may reach (``apps.tasks.access``), and ``layout.py`` decides
where anything may be written. Object keys can contain ``/``, which breaks
DRF's router/pk lookup regex, so keys are passed as query/body params and these
are plain ``APIView``s mounted with ``path()``. Default ``IsAuthenticated``.
"""

from __future__ import annotations

import os

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from rest_framework import status
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.tasks.access import can_reach_drive, has_full_access, visible_drive_keys

from . import b2
from .layout import CATEGORIES, INBOX, check_folder, folder_name, is_hidden, project_folders
from .models import DriveFile
from .serializers import (
    DeleteRequestSerializer,
    FolderRequestSerializer,
    MoveRequestSerializer,
    ShareRequestSerializer,
    UploadUrlRequestSerializer,
)

#: A folder move runs inside one request; past this, do it in a job.
MAX_FOLDER_MOVE = 1000


def _not_found() -> Response:
    return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)


def _error(exc: Exception) -> Response:
    return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))


def _not_configured() -> Response:
    return Response(
        {"detail": "Drive storage is not configured (B2_* env vars unset)."},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


def can_reach(user, key: str) -> bool:
    return can_reach_drive(user, b2._clean(key))


def shared_listing(user) -> dict:
    """A non-staff user's Drive root: the folders and files shared with them
    or uploaded by them.

    ponytail: one HEAD per file; fine for a handful of shares, batch it if
    someone ends up with hundreds.
    """
    keys = sorted(k for k in visible_drive_keys(user) or () if not is_hidden(k))
    files = []
    for key in (k for k in keys if not k.endswith("/")):
        meta = b2.head(key)
        if meta is None:  # presigned but never uploaded, or deleted in B2
            continue
        meta.pop("content_type", None)
        files.append(meta)
    return {"prefix": "", "folders": [k for k in keys if k.endswith("/")],
            "files": files, "next_token": None}


def listing(user, prefix: str, token: str | None = None, *, full: bool | None = None,
            show_system: bool = False) -> dict:
    """The one Drive listing, used by REST and MCP.

    Staff also see every active project and its seven categories before any
    file exists in them, so there is always somewhere to upload; those come
    back in ``empty`` too, so the UI can grey them out.
    """
    full = has_full_access(user) if full is None else full
    prefix = b2._clean(prefix)
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    if is_hidden(prefix) and not show_system:
        raise b2.B2NotFound("No such folder.")
    if not full:
        if not prefix:
            return shared_listing(user)
        if not can_reach_drive(user, prefix):
            raise b2.B2NotFound("No such folder.")
    data = b2.list_objects(prefix, token=token)
    data["empty"] = []
    if full:
        folders = set(data["folders"])
        real = set(folders)
        segments = [s for s in prefix.split("/") if s]
        if not segments:
            folders |= {f"{f}/" for f in project_folders(include_archived=False)} | {INBOX}
        elif len(segments) == 1 and segments[0] in project_folders():
            folders |= {f"{prefix}{c}/" for c in CATEGORIES}
        data["folders"] = sorted(folders)
        data["empty"] = sorted(folders - real)
    if not show_system:
        data["folders"] = [f for f in data["folders"] if not is_hidden(f)]
        data["files"] = [f for f in data["files"] if not is_hidden(f["key"])]
    return data


def claim_upload_key(user, filename: str, prefix: str) -> str:
    """Reserve ``<prefix><name>``, suffixing ``(2)``, ``(3)``… past any
    existing object or reservation — an upload never overwrites."""
    stem, ext = os.path.splitext(os.path.basename(filename) or "file")
    for n in range(1, 1000):
        key = f"{prefix}{stem}{f' ({n})' if n > 1 else ''}{ext}"
        if b2.head(key) is not None:
            continue
        try:
            DriveFile.objects.create(key=key, uploaded_by=user)
        except IntegrityError:  # reserved by someone else
            continue
        return key
    raise b2.B2Error("Too many files with that name.")


def _writable(user, folder: str, full: bool | None = None) -> str:
    """``check_folder`` plus, for non-staff, a folder they can reach."""
    folder = check_folder(folder)
    full = has_full_access(user) if full is None else full
    if not full and not (folder.startswith(INBOX) or can_reach_drive(user, folder)):
        raise b2.B2NotFound("No such folder.")
    return folder


def move_object(user, key: str, to: str, *, full: bool | None = None) -> str:
    """Move a file, or a folder (``key`` ending ``/``), into folder ``to``.

    Used by the Drive page and the MCP ``drive_move`` tool. Project and
    category folders are fixed. Shares follow the file. Non-staff move only
    what they can reach, into a folder they can reach. Returns the new key.
    """
    full = has_full_access(user) if full is None else full
    key = b2._clean(key)
    if is_hidden(key) or (not full and not can_reach_drive(user, key)):
        raise b2.B2NotFound("Not found.")
    to = _writable(user, to, full)
    return _move_folder(key, to) if key.endswith("/") else _move_file(key, to)


def _move_file(key: str, to: str) -> str:
    meta = b2.head(key)
    if meta is None:
        raise b2.B2NotFound("No such file.")
    stem, ext = os.path.splitext(meta["name"])
    for n in range(1, 1000):
        dst = f"{to}{stem}{f' ({n})' if n > 1 else ''}{ext}"
        if dst == key or b2.head(dst) is None:
            break
    if dst != key:
        b2.move(key, dst, meta["size"])
        DriveFile.objects.filter(key=key).update(key=dst)
    return dst


def _move_folder(key: str, to: str) -> str:
    segments = [s for s in key.split("/") if s]
    if key == INBOX or (len(segments) < 3 and not key.startswith(INBOX)):
        raise ValueError("Project and category folders are fixed and can't move.")
    if to.startswith(key):
        raise ValueError("A folder can't move into itself.")
    new = f"{to}{segments[-1]}/"
    if b2.list_keys(new):
        raise ValueError(f"{new} already exists.")
    items = b2.list_keys(key)
    if len(items) > MAX_FOLDER_MOVE:
        raise ValueError(f"Folder has over {MAX_FOLDER_MOVE} files; move it in parts.")
    for k, size in items:
        b2.move(k, new + k[len(key):], size)
    for row in DriveFile.objects.filter(key__startswith=key):
        row.key = new + row.key[len(key):]
        row.save(update_fields=["key"])
    return new


class DriveListView(APIView):
    """GET /api/drive/objects/?prefix=&token=&system=1 — folders + files.

    ``system=1`` (staff only) also shows the pipeline folders and junk files.
    """

    serializer_class = None

    def get(self, request):
        if not b2.is_configured():
            return _not_configured()
        show_system = (
            request.query_params.get("system") == "1" and has_full_access(request.user)
        )
        try:
            return Response(listing(
                request.user, request.query_params.get("prefix", ""),
                request.query_params.get("token") or None, show_system=show_system,
            ))
        except b2.B2Error as exc:
            return _error(exc)


class DriveUploadUrlView(APIView):
    """POST /api/drive/upload-url/ {path, content_type} — presigned PUT URL.

    The folder part of ``path`` must be inside a category (or
    ``to-be-organized/``); a taken name gets a ``(2)`` suffix.
    """

    serializer_class = UploadUrlRequestSerializer

    def post(self, request):
        if not b2.is_configured():
            return _not_configured()
        s = UploadUrlRequestSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        folder, _, name = s.validated_data["path"].replace("\\", "/").rpartition("/")
        if not name.strip():
            return Response({"detail": "A file name is required."}, status=400)
        try:
            key = claim_upload_key(request.user, name, _writable(request.user, folder))
            data = b2.presign_put(
                key, s.validated_data.get("content_type") or "application/octet-stream"
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        except b2.B2Error as exc:
            return _error(exc)
        return Response(data, status=status.HTTP_201_CREATED)


class DriveFolderView(APIView):
    """POST /api/drive/folders/ {parent, name} — create a folder (anyone).

    Only inside a category or ``to-be-organized/``; names are normalized
    (``Q4 Decks`` → ``q4-decks``). A non-staff creator can always reach it.
    """

    serializer_class = FolderRequestSerializer

    def post(self, request):
        if not b2.is_configured():
            return _not_configured()
        s = FolderRequestSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        try:
            parent = _writable(request.user, s.validated_data["parent"])
            folder = f"{parent}{folder_name(s.validated_data['name'])}/"
            data = b2.create_folder(folder)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        except b2.B2Error as exc:
            return _error(exc)
        if not has_full_access(request.user):
            DriveFile.objects.get_or_create(key=folder, defaults={"uploaded_by": request.user})
        return Response(data, status=status.HTTP_201_CREATED)


class DriveMoveView(APIView):
    """POST /api/drive/move/ {key, to} — move a file or folder (anyone)."""

    serializer_class = MoveRequestSerializer

    def post(self, request):
        if not b2.is_configured():
            return _not_configured()
        s = MoveRequestSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        try:
            new = move_object(request.user, s.validated_data["key"], s.validated_data["to"])
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        except b2.B2Error as exc:
            return _error(exc)
        return Response({"ok": True, "key": new})


class DriveShareView(APIView):
    """GET /api/drive/shares/?key= · PUT {key, user_ids} — staff only.

    Who among the non-staff users can see a file or (key ending ``/``) a whole
    folder. ``users`` lists everyone it could be shared with.
    """

    serializer_class = ShareRequestSerializer
    permission_classes = [IsAdminUser]

    @staticmethod
    def _payload(key: str) -> dict:
        row = DriveFile.objects.filter(key=key).first()
        candidates = get_user_model().objects.filter(
            is_active=True, is_staff=False, is_superuser=False
        ).order_by("username")
        return {
            "key": key,
            "shared_with": list(row.shared_with.values_list("pk", flat=True)) if row else [],
            "users": [
                {"id": u.pk, "username": u.username,
                 "name": f"{u.first_name} {u.last_name}".strip()}
                for u in candidates
            ],
        }

    def get(self, request):
        key = b2._clean(request.query_params.get("key", ""))
        if not key or is_hidden(key):
            return Response({"detail": "key is required."}, status=400)
        return Response(self._payload(key))

    def put(self, request):
        s = ShareRequestSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        key = b2._clean(s.validated_data["key"])
        if not key or is_hidden(key):
            return Response({"detail": "key is required."}, status=400)
        row, _ = DriveFile.objects.get_or_create(key=key)
        row.shared_with.set(get_user_model().objects.filter(
            pk__in=s.validated_data["user_ids"], is_staff=False, is_superuser=False,
        ))
        return Response(self._payload(key))


class DriveDownloadUrlView(APIView):
    """GET /api/drive/download-url/?key= — presigned GET URL."""

    serializer_class = None

    def get(self, request):
        if not b2.is_configured():
            return _not_configured()
        key = request.query_params.get("key", "")
        if not key:
            return Response({"detail": "key is required."},
                            status=status.HTTP_400_BAD_REQUEST)
        # ?disposition=inline serves with the object's own Content-Type (for the
        # in-browser viewer); the default forces a download (attachment).
        inline = request.query_params.get("disposition") == "inline"
        if not can_reach(request.user, key):
            return _not_found()
        try:
            url = b2.presign_get(
                key, download_name=None if inline else os.path.basename(key)
            )
        except b2.B2Error as exc:
            return _error(exc)
        return Response({"url": url})


class DriveDeleteView(APIView):
    """DELETE|POST /api/drive/delete/ {key} — delete an object (UI/human only).

    Deliberately NOT exposed over MCP: deletes touch real company files.
    """

    serializer_class = DeleteRequestSerializer

    def delete(self, request):
        return self._delete(request)

    def post(self, request):
        return self._delete(request)

    def _delete(self, request):
        if not b2.is_configured():
            return _not_configured()
        s = DeleteRequestSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        key = s.validated_data["key"]
        # Non-staff may delete only what they uploaded themselves.
        if not has_full_access(request.user) and not DriveFile.objects.filter(
            key=b2._clean(key), uploaded_by=request.user
        ).exists():
            return _not_found()
        try:
            data = b2.delete(key)
            DriveFile.objects.filter(key=b2._clean(key)).delete()
        except b2.B2Error as exc:
            return _error(exc)
        return Response(data)
