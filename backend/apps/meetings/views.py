"""REST API for meetings and the entities that link them.

Auth is the project default (session + ``IsAuthenticated``): every Task
Manager user sees every meeting. All filtering goes through ``query.py`` and
all writes through ``services.py`` — the MCP tools use the same two modules.
"""

from __future__ import annotations

from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from apps.tasks.models import Task

from . import services
from .broadcast import broadcast_meeting_event
from .models import (
    Entity,
    Meeting,
    MeetingCategory,
    MeetingLink,
    MeetingTask,
    Tag,
)
from .query import base_meeting_queryset, filter_meetings
from .related import build_graph, related_meetings
from .serializers import (
    EntitySerializer,
    MeetingCurateSerializer,
    MeetingDetailSerializer,
    MeetingLinkInputSerializer,
    MeetingListSerializer,
    MeetingUpsertSerializer,
)

FILTER_KEYS = (
    "project",
    "category",
    "entity",
    "person",
    "company",
    "tag",
    "date_from",
    "date_to",
    "search",
)


def _filters_from(request) -> dict[str, str]:
    return {k: request.query_params[k] for k in FILTER_KEYS if k in request.query_params}


def _flag(request, name: str, default: bool) -> bool:
    raw = request.query_params.get(name)
    if raw is None:
        return default
    return raw.lower() in ("1", "true", "yes")


def _guard(fn, *args, **kwargs):
    """Surface a refused write as a 400 rather than a 500."""
    try:
        return fn(*args, **kwargs)
    except services.MeetingError as exc:
        raise ValidationError({"detail": str(exc)})


def _announce(meeting: Meeting, event: str = "meeting.updated") -> None:
    broadcast_meeting_event(event, {"key": meeting.key})


class MeetingViewSet(viewsets.ModelViewSet):
    """Meeting CRUD. Lookup is by the human key (``MTG-001``).

    ``POST`` is an **upsert on** ``stem`` — it returns 201 for a new meeting
    and 200 when it refreshed an existing one — so the pipeline can re-push
    freely. ``PATCH`` is a person curating; see ``services`` for how the two
    differ.
    """

    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        if self.action == "list":
            return filter_meetings(_filters_from(self.request), light=True)
        return base_meeting_queryset()

    def get_serializer_class(self):
        if self.action == "list":
            return MeetingListSerializer
        return MeetingDetailSerializer

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.action == "list":
            ctx["search"] = self.request.query_params.get("search", "")
        return ctx

    def _detail(self, meeting: Meeting, *, status_code=status.HTTP_200_OK):
        fresh = base_meeting_queryset().get(pk=meeting.pk)
        data = MeetingDetailSerializer(fresh, context={"request": self.request}).data
        return Response(data, status=status_code)

    def create(self, request, *args, **kwargs):
        payload = MeetingUpsertSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        meeting, created = _guard(
            services.upsert_meeting, payload.validated_data, user=request.user
        )
        _announce(meeting, "meeting.created" if created else "meeting.updated")
        return self._detail(
            meeting,
            status_code=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def partial_update(self, request, *args, **kwargs):
        meeting = self.get_object()
        payload = MeetingCurateSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        _guard(services.curate_meeting, meeting, payload.validated_data)
        _announce(meeting)
        return self._detail(meeting)

    def perform_destroy(self, instance):
        key = instance.key
        instance.delete()
        broadcast_meeting_event("meeting.deleted", {"key": key})

    # -- exploring ---------------------------------------------------------

    @action(detail=False, methods=["get"])
    def graph(self, request):
        return Response(
            build_graph(
                _filters_from(request),
                include_mentioned=_flag(request, "mentioned", False),
                include_projects=_flag(request, "projects", True),
            )
        )

    @action(detail=False, methods=["get"])
    def facets(self, request):
        """Counts behind the filter bar. Always over *all* meetings, so
        picking one filter doesn't make the other options disappear."""
        categories = dict(
            Meeting.objects.values_list("category").annotate(n=Count("id"))
        )
        return Response(
            {
                "total": Meeting.objects.count(),
                "categories": [
                    {"value": value, "label": label, "count": categories.get(value, 0)}
                    for value, label in MeetingCategory.choices
                ],
                "tags": list(
                    Tag.objects.annotate(count=Count("meetings"))
                    .filter(count__gt=0)
                    .order_by("-count", "name")
                    .values("name", "count")
                ),
                "projects": list(
                    Meeting.objects.filter(project__isnull=False)
                    .values("project_id", "project__prefix", "project__name")
                    .annotate(count=Count("id"))
                    .order_by("-count")
                ),
            }
        )

    @action(detail=True, methods=["get"])
    def related(self, request, key=None):
        return Response(related_meetings(self.get_object()))

    # -- action items ------------------------------------------------------

    @action(
        detail=True,
        methods=["patch"],
        url_path=r"action-items/(?P<item_id>[^/]+)",
    )
    def action_item(self, request, key=None, item_id=None):
        meeting = self.get_object()
        if "done" not in request.data:
            raise ValidationError({"done": "This field is required."})
        _guard(
            services.set_action_item_done, meeting, item_id, bool(request.data["done"])
        )
        _announce(meeting)
        return self._detail(meeting)

    @action(
        detail=True,
        methods=["post"],
        url_path=r"action-items/(?P<item_id>[^/]+)/create-task",
    )
    def action_item_create_task(self, request, key=None, item_id=None):
        meeting = self.get_object()
        _guard(
            services.create_task_from_action_item,
            meeting,
            item_id,
            user=request.user,
            project=request.data.get("project"),
        )
        _announce(meeting)
        return self._detail(meeting, status_code=status.HTTP_201_CREATED)

    # -- links -------------------------------------------------------------

    @action(detail=True, methods=["post", "delete"], url_path="tasks")
    def tasks(self, request, key=None):
        meeting = self.get_object()
        task = get_object_or_404(Task, key=request.data.get("task", ""))
        if request.method == "POST":
            MeetingTask.objects.get_or_create(meeting=meeting, task=task)
        else:
            MeetingTask.objects.filter(meeting=meeting, task=task).delete()
        _announce(meeting)
        return self._detail(meeting)

    @action(detail=True, methods=["post", "delete"], url_path="links")
    def links(self, request, key=None):
        meeting = self.get_object()
        payload = MeetingLinkInputSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        other = get_object_or_404(Meeting, key=payload.validated_data["to"])
        if other.pk == meeting.pk:
            raise ValidationError({"to": "A meeting can't link to itself."})
        either_way = Q(from_meeting=meeting, to_meeting=other) | Q(
            from_meeting=other, to_meeting=meeting
        )
        if request.method == "DELETE":
            MeetingLink.objects.filter(either_way).delete()
        elif not MeetingLink.objects.filter(either_way).exists():
            MeetingLink.objects.create(
                from_meeting=meeting,
                to_meeting=other,
                kind=payload.validated_data["kind"],
                note=payload.validated_data["note"],
            )
        _announce(meeting)
        _announce(other)
        return Response(related_meetings(meeting))


class EntityViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """People and companies. Created implicitly by ingest, so there is no
    ``POST``; the API is for fixing them up (rename, alias, merge)."""

    serializer_class = EntitySerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        qs = Entity.objects.select_related("company").annotate(
            meeting_count=Count("meetings", distinct=True)
        )
        kind = self.request.query_params.get("kind")
        if kind:
            qs = qs.filter(kind=kind)
        term = (self.request.query_params.get("search") or "").strip()
        if term:
            qs = qs.filter(name__icontains=term)
        return qs.order_by("-meeting_count", "name")

    def perform_update(self, serializer):
        entity = serializer.save()
        broadcast_meeting_event("entity.updated", {"id": entity.id})

    def perform_destroy(self, instance):
        entity_id = instance.id
        instance.delete()
        broadcast_meeting_event("entity.updated", {"id": entity_id})

    @action(detail=True, methods=["post"])
    def merge(self, request, pk=None):
        """Fold this entity into ``into`` — for the "Ali" / "Ali K." split."""
        source = self.get_object()
        into = str(request.data.get("into") or "")
        if not into.isdigit():
            raise ValidationError({"into": "Id of the entity to merge into."})
        target = get_object_or_404(Entity, pk=int(into))
        target = _guard(services.merge_entities, source, target)
        broadcast_meeting_event("entity.updated", {"id": target.id})
        return Response(EntitySerializer(self.get_queryset().get(pk=target.pk)).data)
