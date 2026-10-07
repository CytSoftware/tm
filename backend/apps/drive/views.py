"""DRF endpoints for the Drive — a Backblaze B2 file browser.

B2 is the source of truth for what exists; ``DriveFile`` rows only decide what
a non-staff user may reach (``apps.tasks.access``). Object keys can contain ``/``,
which breaks DRF's router/pk lookup regex, so keys are passed as query/body
params and these are plain ``APIView``s mounted with ``path()`` (same style as
``tasks.UploadImageView``). Default ``IsAuthenticated`` (session) applies.
"""

from __future__ import annotations

import os

from django.db import IntegrityError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.tasks.access import has_full_access, visible_drive_keys

from . import b2
from .models import DriveFile
from .serializers import DeleteRequestSerializer, UploadUrlRequestSerializer

#: Where non-staff uploads land. The server picks the key so an upload can
#: never overwrite a file the uploader can't see.
UPLOAD_PREFIX = "uploads/"


def _not_found() -> Response:
    return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)


def _can_reach(user, key: str) -> bool:
    visible = visible_drive_keys(user)
    return visible is None or b2._clean(key) in visible


def _shared_listing(user) -> dict:
    """Flat list of the files a non-staff user can reach — no folders.

    ponytail: one HEAD per file; fine for a handful of shares, batch it if
    someone ends up with hundreds.
    """
    files = []
    for key in sorted(visible_drive_keys(user) or ()):
        meta = b2.head(key)
        if meta is None:  # presigned but never uploaded, or deleted in B2
            continue
        meta.pop("content_type", None)
        files.append(meta)
    return {"prefix": "", "folders": [], "files": files, "next_token": None}


def _claim_upload_key(user, filename: str) -> str:
    """Reserve ``uploads/<name>``, suffixing ``(2)``, ``(3)``… past any
    existing object or reservation."""
    stem, ext = os.path.splitext(os.path.basename(filename) or "file")
    for n in range(1, 1000):
        key = f"{UPLOAD_PREFIX}{stem}{f' ({n})' if n > 1 else ''}{ext}"
        if b2.head(key) is not None:
            continue
        try:
            DriveFile.objects.create(key=key, uploaded_by=user)
        except IntegrityError:  # reserved by someone else
            continue
        return key
    raise b2.B2Error("Too many files with that name.")


def _not_configured() -> Response:
    return Response(
        {"detail": "Drive storage is not configured (B2_* env vars unset)."},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


class DriveListView(APIView):
    """GET /api/drive/objects/?prefix=&token= — folders + files under a prefix."""

    serializer_class = None

    def get(self, request):
        if not b2.is_configured():
            return _not_configured()
        prefix = request.query_params.get("prefix", "")
        token = request.query_params.get("token") or None
        try:
            if not has_full_access(request.user):
                return Response(_shared_listing(request.user))
            return Response(b2.list_objects(prefix, token=token))
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))


class DriveUploadUrlView(APIView):
    """POST /api/drive/upload-url/ {path, content_type} — presigned PUT URL."""

    serializer_class = UploadUrlRequestSerializer

    def post(self, request):
        if not b2.is_configured():
            return _not_configured()
        s = UploadUrlRequestSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        path = s.validated_data["path"]
        try:
            if not has_full_access(request.user):
                path = _claim_upload_key(request.user, path)
            data = b2.presign_put(
                path,
                s.validated_data.get("content_type") or "application/octet-stream",
            )
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))
        return Response(data, status=status.HTTP_201_CREATED)


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
        if not _can_reach(request.user, key):
            return _not_found()
        try:
            url = b2.presign_get(
                key, download_name=None if inline else os.path.basename(key)
            )
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))
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
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))
        return Response(data)
