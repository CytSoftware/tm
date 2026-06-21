"""DRF viewset for the wiki app.

Body content is owned by the Yjs collab socket — the REST surface only manages
metadata (title / parent / project), ordering, deletion, and a denormalized
snapshot push. There is intentionally no REST path that writes the doc body
into the CRDT.
"""

from __future__ import annotations

from asgiref.sync import async_to_sync
from django.conf import settings
from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .broadcast import broadcast_wiki_event
from .models import Doc
from .query import apply_doc_filters, apply_doc_sort, base_doc_queryset
from .serializers import (
    DocDetailSerializer,
    DocMoveSerializer,
    DocReadSerializer,
    DocSnapshotSerializer,
    DocWriteSerializer,
)
from .utils import extract_plain_text


def _extract_filters(params) -> dict:
    filters: dict = {}
    if project := params.get("project"):
        filters["project"] = project
    if parent := params.get("parent"):
        filters["parent"] = parent
    if search := params.get("search"):
        filters["search"] = search
    return filters


_SORT_DIRS = {"asc", "desc"}


def _extract_sort(params) -> list | None:
    field = params.get("sort_field")
    if not field:
        return None
    direction = (params.get("sort_dir") or "asc").lower()
    if direction not in _SORT_DIRS:
        direction = "asc"
    return [{"field": field, "dir": direction}]


class DocViewSet(viewsets.ModelViewSet):
    """Wiki page CRUD. Lookup is by the human key (``DOC-001``).

    The list endpoint returns the full (filtered) flat set with no pagination —
    the client assembles the tree from ``parent`` + ``position``.
    """

    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"
    pagination_class = None

    def get_queryset(self):
        qs = base_doc_queryset()
        params = self.request.query_params
        filters = _extract_filters(params)
        sort = _extract_sort(params)
        if filters or sort:
            qs = apply_doc_filters(qs, filters, requesting_user=self.request.user)
            qs = apply_doc_sort(qs, sort)
        return qs

    def get_serializer_class(self):
        if self.action == "retrieve":
            return DocDetailSerializer
        if self.action in {"list", "move"}:
            return DocReadSerializer
        return DocWriteSerializer

    # -- create / update / delete ------------------------------------------

    def perform_create(self, serializer):
        doc = serializer.save()
        broadcast_wiki_event(
            "wiki.created",
            {"key": doc.key, "id": doc.id, "parent_id": doc.parent_id},
        )

    def perform_update(self, serializer):
        doc = serializer.save()
        broadcast_wiki_event(
            "wiki.updated",
            {"key": doc.key, "id": doc.id, "parent_id": doc.parent_id},
        )

    def perform_destroy(self, instance):
        key = instance.key
        instance.delete()  # cascades the subtree + DocState rows
        broadcast_wiki_event("wiki.deleted", {"key": key})

    # -- move / reparent ----------------------------------------------------

    @action(detail=True, methods=["post"], serializer_class=DocMoveSerializer)
    def move(self, request, key=None):
        """Atomically reparent and/or reposition a page among its siblings."""
        doc = self.get_object()
        payload = DocMoveSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        with transaction.atomic():
            locked = Doc.objects.select_for_update().get(pk=doc.pk)

            if "parent_id" in data:
                target_parent_id = data["parent_id"]
                if target_parent_id is not None:
                    if target_parent_id == locked.id:
                        raise ValidationError(
                            {"parent_id": "A page cannot be its own parent."}
                        )
                    if not Doc.objects.filter(pk=target_parent_id).exists():
                        raise ValidationError({"parent_id": "Parent not found."})
                    if _would_cycle(target_parent_id, locked.id):
                        raise ValidationError(
                            {"parent_id": "Cannot move a page into its own subtree."}
                        )
                locked.parent_id = target_parent_id

            if data.get("position") is not None:
                locked.position = float(data["position"])
            else:
                locked.position = _compute_position(
                    parent_id=locked.parent_id,
                    before_id=data.get("before_id"),
                    after_id=data.get("after_id"),
                    doc_id=locked.id,
                )
            locked.save(update_fields=["parent", "position", "updated_at"])

        broadcast_wiki_event(
            "wiki.moved",
            {"key": locked.key, "id": locked.id, "parent_id": locked.parent_id},
        )
        fresh = self.get_queryset().get(pk=locked.pk)
        return Response(
            DocReadSerializer(fresh, context=self.get_serializer_context()).data
        )

    # -- denormalized body snapshot ----------------------------------------

    @action(detail=True, methods=["post"], serializer_class=DocSnapshotSerializer)
    def snapshot(self, request, key=None):
        """Persist a client-pushed body snapshot (Plate value) for read/search.

        The CRDT (DocState, written by the collab socket) remains the source of
        truth; this keeps ``content``/``plain_text`` reasonably fresh for
        read-only render, MCP and search. Single writer for the Doc row's
        ``last_edited_by``/``updated_at`` to avoid racing the collab consumer.
        """
        doc = self.get_object()
        payload = DocSnapshotSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        content = payload.validated_data["content"]
        if not isinstance(content, list):
            raise ValidationError({"content": "Expected a list of nodes."})

        user = request.user if request.user.is_authenticated else None
        Doc.objects.filter(pk=doc.pk).update(
            content=content,
            plain_text=extract_plain_text(content),
            last_edited_by=user,
            updated_at=timezone.now(),
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


def _would_cycle(target_parent_id: int, doc_id: int) -> bool:
    """True if making ``target_parent_id`` the parent of ``doc_id`` cycles.

    Walks the ancestor chain of the target parent; if ``doc_id`` appears, the
    target is inside the doc's own subtree.
    """
    cur = target_parent_id
    seen: set[int] = set()
    while cur is not None:
        if cur == doc_id:
            return True
        if cur in seen:  # defensive: pre-existing cycle, bail
            break
        seen.add(cur)
        cur = (
            Doc.objects.filter(pk=cur).values_list("parent_id", flat=True).first()
        )
    return False


def _compute_position(
    *,
    parent_id: int | None,
    before_id: int | None,
    after_id: int | None,
    doc_id: int,
) -> float:
    """Midpoint positioning among siblings of ``parent_id``. Mirrors pipelines."""
    _rebalance_if_tied(parent_id, exclude_doc_id=doc_id)

    siblings = Doc.objects.filter(parent_id=parent_id)

    after = (
        siblings.filter(id=after_id).exclude(id=doc_id).first() if after_id else None
    )
    before = (
        siblings.filter(id=before_id).exclude(id=doc_id).first() if before_id else None
    )

    if after and before:
        return (after.position + before.position) / 2.0
    if after and not before:
        bigger = (
            siblings.filter(position__gt=after.position)
            .exclude(id=doc_id)
            .order_by("position", "id")
            .values_list("position", flat=True)
            .first()
        )
        if bigger is None:
            return after.position + 1000.0
        return (after.position + bigger) / 2.0
    if before and not after:
        smaller = (
            siblings.filter(position__lt=before.position)
            .exclude(id=doc_id)
            .order_by("-position", "-id")
            .values_list("position", flat=True)
            .first()
        )
        if smaller is None:
            return before.position - 1000.0
        return (smaller + before.position) / 2.0
    tail = siblings.exclude(id=doc_id).aggregate(m=Max("position"))["m"]
    return (tail or 0) + 1000.0


def _rebalance_if_tied(parent_id: int | None, *, exclude_doc_id: int) -> None:
    neighbors = Doc.objects.filter(parent_id=parent_id).exclude(id=exclude_doc_id)
    positions = list(neighbors.values_list("position", flat=True))
    if len(positions) == len(set(positions)):
        return
    ordered = list(neighbors.order_by("position", "id"))
    for i, p in enumerate(ordered, start=1):
        p.position = i * 1000.0
    Doc.objects.bulk_update(ordered, ["position"])


# ---------------------------------------------------------------------------
# Internal: cross-process wiki content-write bridge (stdio MCP → daphne)
# ---------------------------------------------------------------------------


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
def internal_wiki_apply(request):
    """Run a Markdown body write inside daphne, for the stdio MCP process.

    The stdio MCP process can't reach daphne's in-memory collab rooms or the
    Channels layer, so it POSTs the operation here. ``async_to_sync`` re-enters
    daphne's own event loop (asgiref routes it back to the parent loop), so the
    write touches the live room + connected editors correctly. Authenticated by
    the shared broadcast secret; refuses non-loopback callers.
    """
    from .content_ops import apply_content

    host = request.META.get("REMOTE_ADDR", "")
    if host not in ("127.0.0.1", "::1"):
        return Response({"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN)

    provided = request.META.get("HTTP_X_CYT_BROADCAST_SECRET", "")
    if provided != getattr(settings, "CYT_BROADCAST_SECRET", ""):
        return Response({"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN)

    data = request.data or {}
    key = data.get("key")
    markdown = data.get("markdown")
    operation = data.get("operation")
    index = data.get("index")
    user_id = data.get("user_id")
    if not isinstance(key, str) or not isinstance(markdown, str):
        return Response(
            {"detail": "Invalid payload."}, status=status.HTTP_400_BAD_REQUEST
        )

    try:
        result = async_to_sync(apply_content)(
            key,
            markdown=markdown,
            operation=operation,
            index=index,
            user_id=user_id,
        )
    except ValueError as e:
        return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(result)
