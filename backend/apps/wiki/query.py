"""Shared wiki query helpers.

Single source of truth for filtering/sorting docs, used by both the DRF
viewset and the MCP tools (mirroring ``apps.tasks.query`` /
``apps.pipelines.query``). Do not duplicate this logic in a consumer —
extend these helpers.

Filter shape::

    {
        "project": 3,        # id, or "none" for workspace-global only
        "parent": "root",    # id, or "root"/"none" for top-level only
        "search": "deploy",
    }

Sort entries: ``[{"field": "updated_at", "dir": "desc"}, ...]``.
"""

from __future__ import annotations

from typing import Any, Mapping

from django.db.models import Exists, OuterRef, Q, QuerySet

from .models import Doc

SORTABLE_FIELDS = {"created_at", "updated_at", "title", "position"}


def base_doc_queryset() -> QuerySet[Doc]:
    """Pre-joined queryset with a ``has_children`` annotation for the tree.

    Deliberately does NOT include ``content`` deferral tricks — DocState (the
    big CRDT blob) lives in a separate table, so list reads are already lean.
    """
    children = Doc.objects.filter(parent_id=OuterRef("pk"))
    return (
        Doc.objects.select_related(
            "parent",
            "project",
            "created_by",
            "created_by__profile",
            "last_edited_by",
            "last_edited_by__profile",
        )
        .annotate(has_children=Exists(children))
        .order_by("parent_id", "position", "id")
    )


def apply_doc_filters(
    qs: QuerySet[Doc],
    filters: Mapping[str, Any] | None,
    *,
    requesting_user=None,
) -> QuerySet[Doc]:
    if not filters:
        return qs

    if (raw_project := filters.get("project")) not in (None, ""):
        if raw_project in ("none", "null"):
            qs = qs.filter(project__isnull=True)
        elif isinstance(raw_project, int) or (
            isinstance(raw_project, str) and raw_project.isdigit()
        ):
            qs = qs.filter(project_id=int(raw_project))

    if (raw_parent := filters.get("parent")) not in (None, ""):
        if raw_parent in ("root", "none", "null"):
            qs = qs.filter(parent__isnull=True)
        elif isinstance(raw_parent, int) or (
            isinstance(raw_parent, str) and raw_parent.isdigit()
        ):
            qs = qs.filter(parent_id=int(raw_parent))

    if search := filters.get("search"):
        if isinstance(search, str) and (stripped := search.strip()):
            for word in stripped.split():
                qs = qs.filter(
                    Q(key__icontains=word)
                    | Q(title__icontains=word)
                    | Q(plain_text__icontains=word)
                )

    return qs


def apply_doc_sort(
    qs: QuerySet[Doc], sort: list[Mapping[str, str]] | None
) -> QuerySet[Doc]:
    if not sort:
        return qs

    order_fields: list[str] = []
    for entry in sort:
        field = entry.get("field")
        direction = (entry.get("dir") or "asc").lower()
        if not field or field not in SORTABLE_FIELDS:
            continue
        prefix = "-" if direction == "desc" else ""
        order_fields.append(f"{prefix}{field}")

    if not order_fields:
        return qs
    return qs.order_by(*order_fields, "id")


def filter_and_sort_docs(
    filters: Mapping[str, Any] | None = None,
    sort: list[Mapping[str, str]] | None = None,
    *,
    requesting_user=None,
    base: QuerySet[Doc] | None = None,
) -> QuerySet[Doc]:
    qs = base if base is not None else base_doc_queryset()
    qs = apply_doc_filters(qs, filters, requesting_user=requesting_user)
    qs = apply_doc_sort(qs, sort)
    return qs
