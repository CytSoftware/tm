"""Authenticated management/list APIs for the inbound event inbox."""

from __future__ import annotations

from django.db.models import Count, Q
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import EventSource, EventWorkflowStatus, ExternalEvent
from .serializers import EventSourceSerializer, ExternalEventSerializer


class EventSourceViewSet(viewsets.ModelViewSet):
    serializer_class = EventSourceSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return EventSource.objects.none()
        return EventSource.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


class ExternalEventViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = ExternalEventSerializer
    http_method_names = ["get", "patch", "head", "options"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return ExternalEvent.objects.none()
        qs = ExternalEvent.objects.filter(source__user=self.request.user).select_related(
            "source"
        )
        source = self.request.query_params.get("source")
        if source:
            qs = qs.filter(source_id=source)
        status = self.request.query_params.get("workflow_status")
        if status in EventWorkflowStatus.values:
            qs = qs.filter(workflow_status=status)
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(
                Q(title__icontains=search)
                | Q(external_id__icontains=search)
                | Q(source__name__icontains=search)
            )
        return qs

    @action(detail=False, methods=["get"])
    def summary(self, request):
        qs = ExternalEvent.objects.filter(source__user=request.user)
        source = request.query_params.get("source")
        if source:
            qs = qs.filter(source_id=source)
        counts = {
            row["workflow_status"]: row["count"]
            for row in qs.values("workflow_status").annotate(count=Count("id"))
        }
        return Response(
            {
                "total": sum(counts.values()),
                **{status: counts.get(status, 0) for status in EventWorkflowStatus.values},
            }
        )
