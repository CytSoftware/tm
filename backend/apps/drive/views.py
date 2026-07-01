"""DRF endpoints for the Drive — a Backblaze B2 file browser.

B2 is the source of truth; there are no models. Object keys can contain ``/``,
which breaks DRF's router/pk lookup regex, so keys are passed as query/body
params and these are plain ``APIView``s mounted with ``path()`` (same style as
``tasks.UploadImageView``). Default ``IsAuthenticated`` (session) applies.
"""

from __future__ import annotations

import os

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import b2
from .serializers import DeleteRequestSerializer, UploadUrlRequestSerializer


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
        try:
            data = b2.presign_put(
                s.validated_data["path"],
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
        try:
            data = b2.delete(s.validated_data["key"])
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))
        return Response(data)
