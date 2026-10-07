"""DRF endpoints for the LLM Wiki — read-only markdown pages in B2 (llm-wiki/).

Humans read; agents write via MCP (single writer, no synthesis worker yet).
B2 is the source of truth; ``KnowledgePageProject`` rows decide which pages a
non-staff user may read. Reuses ``apps.drive.b2`` for storage.
"""

from __future__ import annotations

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.drive import b2
from apps.tasks.access import visible_knowledge_slugs


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
            pages = b2.wiki_list()
            if (visible := visible_knowledge_slugs(request.user)) is not None:
                pages = [p for p in pages if p["slug"] in visible]
            return Response(pages)
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))


class KnowledgePageDetailView(APIView):
    """GET /api/knowledge/pages/<slug>/ — one page's markdown body."""

    serializer_class = None

    def get(self, request, slug: str):
        if not b2.is_configured():
            return _not_configured()
        visible = visible_knowledge_slugs(request.user)
        try:
            if visible is not None and b2.slugify(slug) not in visible:
                raise b2.B2NotFound(f"No such wiki page: {slug!r}")
            return Response(b2.wiki_read(slug))
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))


class KnowledgeGraphView(APIView):
    """GET /api/knowledge/graph/ — ``{nodes, links}`` from resolved wikilinks."""

    serializer_class = None

    def get(self, request):
        if not b2.is_configured():
            return _not_configured()
        try:
            graph = b2.wiki_graph()
            if (visible := visible_knowledge_slugs(request.user)) is not None:
                graph = {
                    "nodes": [n for n in graph["nodes"] if n["id"] in visible],
                    "links": [
                        e for e in graph["links"]
                        if e["source"] in visible and e["target"] in visible
                    ],
                }
            return Response(graph)
        except b2.B2Error as exc:
            return Response({"detail": str(exc)}, status=getattr(exc, "status_code", 400))
