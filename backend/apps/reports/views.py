"""Read API for reports. Bots publish over MCP (``publish_report``); the UI
only lists, reads and — for staff — deletes."""

from __future__ import annotations

from rest_framework import mixins, permissions, viewsets
from rest_framework.exceptions import NotFound

from apps.tasks.access import StaffOnlyActions

from . import services
from .serializers import ReportDetailSerializer, ReportSerializer


class ReportViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    lookup_value_regex = r"[A-Za-z0-9\-]+"
    permission_classes = [permissions.IsAuthenticated, StaffOnlyActions]
    staff_only_actions = {"destroy"}

    def get_queryset(self):
        return services.visible_reports(
            self.request.user, search=self.request.query_params.get("q", "").strip()
        )

    def get_serializer_class(self):
        return ReportSerializer if self.action == "list" else ReportDetailSerializer

    def get_object(self):
        try:
            return services.get_report(self.request.user, self.kwargs["pk"])
        except services.ReportError as exc:
            raise NotFound(str(exc))
