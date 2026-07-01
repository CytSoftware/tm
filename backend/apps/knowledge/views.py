"""DRF endpoints for the LLM Wiki — read-only markdown pages in B2 (llm-wiki/).

Humans read; agents write via MCP (single writer, no synthesis worker yet).
No models — B2 is the source of truth. Reuses ``apps.drive.b2`` for storage.
"""

from __future__ import annotations

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.drive import b2


def _not_configured() -> Response:
    return Response(
        {"detail": "Knowledge storage is not configured (B2_* env vars unset)."},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


class KnowledgePageListView(APIView):
    """GET /api/knowledge/pages/ — list wiki pages (slug + title + metadata)."""

    serializer_class = None

    def get(self, request):
        if not b2.is_configured():
            return _not_configured()
        try:
            return Response(b2.wiki_list())
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))


class KnowledgePageDetailView(APIView):
    """GET /api/knowledge/pages/<slug>/ — one page's markdown body."""

    serializer_class = None

    def get(self, request, slug: str):
        if not b2.is_configured():
            return _not_configured()
        try:
            return Response(b2.wiki_read(slug))
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))
