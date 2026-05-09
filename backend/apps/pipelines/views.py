"""DRF viewsets for pipelines."""

from __future__ import annotations

from django.db import transaction
from django.db.models import Max
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from drf_spectacular.utils import extend_schema

from .broadcast import broadcast_pipeline_event
from .models import Pipeline, PipelineEvent, Stage
from .query import (
    apply_pipeline_filters,
    apply_pipeline_sort,
    base_pipeline_queryset,
)
from .serializers import (
    PipelineDetailSerializer,
    PipelineEventSerializer,
    PipelineEventWriteSerializer,
    PipelineMoveSerializer,
    PipelineReadSerializer,
    PipelineWriteSerializer,
    StageSerializer,
)


class StageViewSet(viewsets.ReadOnlyModelViewSet):
    """Stages are read-only via the API in v1; manage them in admin."""

    queryset = Stage.objects.all().order_by("order")
    serializer_class = StageSerializer
    pagination_class = None  # tiny set


def _extract_filters(params) -> dict:
    filters: dict = {}
    if stage := params.get("stage"):
        filters["stage"] = stage
    owners = [o for o in params.getlist("owner") if o]
    if owners:
        filters["owner"] = owners
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


class PipelineViewSet(viewsets.ModelViewSet):
    """All pipeline CRUD. Lookup is by the human key (``PIPE-001``)."""

    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"

    def get_queryset(self):
        qs = base_pipeline_queryset()
        params = self.request.query_params
        filters = _extract_filters(params)
        sort = _extract_sort(params)
        if filters or sort:
            qs = apply_pipeline_filters(
                qs, filters, requesting_user=self.request.user
            )
            qs = apply_pipeline_sort(qs, sort)
        return qs

    def get_serializer_class(self):
        if self.action == "retrieve":
            return PipelineDetailSerializer
        if self.action in {"list", "move"}:
            return PipelineReadSerializer
        return PipelineWriteSerializer

    def perform_create(self, serializer):
        pipeline = serializer.save()
        broadcast_pipeline_event(
            "pipeline.created", {"key": pipeline.key, "id": pipeline.id}
        )

    def perform_update(self, serializer):
        pipeline = serializer.save()
        broadcast_pipeline_event(
            "pipeline.updated", {"key": pipeline.key, "id": pipeline.id}
        )

    def perform_destroy(self, instance):
        key = instance.key
        instance.delete()
        broadcast_pipeline_event("pipeline.deleted", {"key": key})

    @action(detail=True, methods=["post"], serializer_class=PipelineMoveSerializer)
    def move(self, request, key=None):
        """Atomically move a pipeline to a new stage + position."""
        pipeline = self.get_object()
        payload = PipelineMoveSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        try:
            stage = Stage.objects.get(pk=data["stage_id"])
        except Stage.DoesNotExist as e:
            raise ValidationError({"stage_id": "Stage not found."}) from e

        with transaction.atomic():
            pipeline.stage = stage
            if data.get("position") is not None:
                pipeline.position = float(data["position"])
            else:
                pipeline.position = _compute_position(
                    stage=stage,
                    before_id=data.get("before_id"),
                    after_id=data.get("after_id"),
                    pipeline_id=pipeline.id,
                )
            pipeline.save(update_fields=["stage", "position", "updated_at"])

        broadcast_pipeline_event(
            "pipeline.moved",
            {"key": pipeline.key, "id": pipeline.id, "stage_id": stage.id},
        )
        fresh = self.get_queryset().get(pk=pipeline.pk)
        return Response(
            PipelineReadSerializer(fresh, context=self.get_serializer_context()).data
        )

    @action(
        detail=True,
        methods=["get", "post"],
        url_path="events",
        serializer_class=PipelineEventSerializer,
    )
    def events(self, request, key=None):
        """List or append timeline events for a pipeline."""
        pipeline = self.get_object()
        if request.method == "GET":
            qs = pipeline.events.select_related("author", "author__profile").order_by(
                "created_at", "id"
            )
            return Response(
                PipelineEventSerializer(
                    qs, many=True, context=self.get_serializer_context()
                ).data
            )

        write = PipelineEventWriteSerializer(data=request.data)
        write.is_valid(raise_exception=True)
        event = PipelineEvent.objects.create(
            pipeline=pipeline,
            body=write.validated_data.get("body", ""),
            author=request.user if request.user.is_authenticated else None,
        )
        broadcast_pipeline_event(
            "pipeline.event_added",
            {
                "key": pipeline.key,
                "id": pipeline.id,
                "event_id": event.id,
            },
        )
        return Response(
            PipelineEventSerializer(
                event, context=self.get_serializer_context()
            ).data,
            status=status.HTTP_201_CREATED,
        )


def _compute_position(
    *,
    stage: Stage,
    before_id: int | None,
    after_id: int | None,
    pipeline_id: int,
) -> float:
    """Midpoint positioning for drag-and-drop. Mirrors the task version."""
    _rebalance_if_tied(stage, exclude_pipeline_id=pipeline_id)

    after = (
        Pipeline.objects.filter(id=after_id).exclude(id=pipeline_id).first()
        if after_id
        else None
    )
    before = (
        Pipeline.objects.filter(id=before_id).exclude(id=pipeline_id).first()
        if before_id
        else None
    )

    if after and before:
        return (after.position + before.position) / 2.0
    if after and not before:
        bigger = (
            Pipeline.objects.filter(stage=stage, position__gt=after.position)
            .exclude(id=pipeline_id)
            .order_by("position", "id")
            .values_list("position", flat=True)
            .first()
        )
        if bigger is None:
            return after.position + 1000.0
        return (after.position + bigger) / 2.0
    if before and not after:
        smaller = (
            Pipeline.objects.filter(stage=stage, position__lt=before.position)
            .exclude(id=pipeline_id)
            .order_by("-position", "-id")
            .values_list("position", flat=True)
            .first()
        )
        if smaller is None:
            return before.position - 1000.0
        return (smaller + before.position) / 2.0
    tail = stage.pipelines.exclude(id=pipeline_id).aggregate(m=Max("position"))["m"]
    return (tail or 0) + 1000.0


def _rebalance_if_tied(stage: Stage, *, exclude_pipeline_id: int) -> None:
    neighbors = stage.pipelines.exclude(id=exclude_pipeline_id)
    positions = list(neighbors.values_list("position", flat=True))
    if len(positions) == len(set(positions)):
        return
    ordered = list(neighbors.order_by("position", "id"))
    for i, p in enumerate(ordered, start=1):
        p.position = i * 1000.0
    Pipeline.objects.bulk_update(ordered, ["position"])
