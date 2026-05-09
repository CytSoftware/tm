"""Shared pipeline query helpers.

Single source of truth for filtering and sorting pipelines, used by both the
DRF viewset and the MCP tools (mirroring ``apps.tasks.query``).

Filter shape:

    {
        "stage": 3,        # id or name
        "owner": [1, 2],   # ids or usernames or "me"
        "search": "acme",
    }

Sort entries: ``[{"field": "updated_at", "dir": "desc"}, ...]``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from django.contrib.auth import get_user_model
from django.db.models import Count, Max, Q, QuerySet

from .models import Pipeline

User = get_user_model()

SORTABLE_FIELDS = {
    "created_at",
    "updated_at",
    "title",
    "position",
    "last_event_at",
}


def base_pipeline_queryset() -> QuerySet[Pipeline]:
    """Pre-joined queryset with event-count + last-event annotations."""
    return (
        Pipeline.objects.select_related(
            "stage", "owner", "owner__profile", "created_by"
        )
        .annotate(
            event_count=Count("events", distinct=True),
            last_event_at=Max("events__created_at"),
        )
        .order_by("stage__order", "position", "id")
    )


def _resolve_user_ids(values: Iterable[Any], requesting_user) -> list[int]:
    ids: list[int] = []
    usernames: list[str] = []
    for v in values:
        if isinstance(v, int):
            ids.append(v)
        elif isinstance(v, str):
            if v == "me" and requesting_user and requesting_user.is_authenticated:
                ids.append(requesting_user.pk)
            elif v.isdigit():
                ids.append(int(v))
            else:
                usernames.append(v)
    if usernames:
        ids.extend(
            User.objects.filter(username__in=usernames).values_list("id", flat=True)
        )
    return ids


def apply_pipeline_filters(
    qs: QuerySet[Pipeline],
    filters: Mapping[str, Any] | None,
    *,
    requesting_user=None,
) -> QuerySet[Pipeline]:
    if not filters:
        return qs

    if (raw_stage := filters.get("stage")) not in (None, ""):
        if isinstance(raw_stage, int) or (
            isinstance(raw_stage, str) and raw_stage.isdigit()
        ):
            qs = qs.filter(stage_id=int(raw_stage))
        elif isinstance(raw_stage, str):
            qs = qs.filter(stage__name__iexact=raw_stage)

    if owner_values := filters.get("owner"):
        if not isinstance(owner_values, (list, tuple)):
            owner_values = [owner_values]
        include_none = "none" in owner_values
        real_values = [v for v in owner_values if v != "none"]
        ids = _resolve_user_ids(real_values, requesting_user) if real_values else []
        if include_none and ids:
            qs = qs.filter(Q(owner_id__in=ids) | Q(owner__isnull=True))
        elif include_none:
            qs = qs.filter(owner__isnull=True)
        elif ids:
            qs = qs.filter(owner_id__in=ids)
        else:
            qs = qs.none()

    if search := filters.get("search"):
        if isinstance(search, str) and (stripped := search.strip()):
            for word in stripped.split():
                qs = qs.filter(
                    Q(key__icontains=word)
                    | Q(title__icontains=word)
                    | Q(counterparty__icontains=word)
                    | Q(description__icontains=word)
                )

    return qs


def apply_pipeline_sort(
    qs: QuerySet[Pipeline], sort: list[Mapping[str, str]] | None
) -> QuerySet[Pipeline]:
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


def filter_and_sort_pipelines(
    filters: Mapping[str, Any] | None = None,
    sort: list[Mapping[str, str]] | None = None,
    *,
    requesting_user=None,
    base: QuerySet[Pipeline] | None = None,
) -> QuerySet[Pipeline]:
    qs = base if base is not None else base_pipeline_queryset()
    qs = apply_pipeline_filters(qs, filters, requesting_user=requesting_user)
    qs = apply_pipeline_sort(qs, sort)
    return qs
