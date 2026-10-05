"""REST API for the CRM (mounted at ``/api/crm/``).

Auth is the project default (session + ``IsAuthenticated``). All filtering
goes through ``query.py`` and all writes through ``services.py`` — the MCP
tools use the same two modules.
"""

from __future__ import annotations

from django.db.models import Count
from django.shortcuts import get_object_or_404
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.meetings.models import Entity, EntityKind, EntityRole

from . import services
from .site_preview import PreviewError, preview_site
from .models import Deal, FollowUp, Pipeline, Stage, Touchpoint
from .query import (
    base_contact_queryset,
    bucket_follow_ups,
    base_deal_queryset,
    filter_contacts,
    filter_deals,
    open_follow_ups,
    without_listed_companies_people,
)
from .serializers import (
    ContactSerializer,
    ContactWriteSerializer,
    DealSerializer,
    DealWriteSerializer,
    FollowUpInputSerializer,
    PipelineSerializer,
    StageSpecSerializer,
    TouchpointInputSerializer,
    TouchpointPatchSerializer,
    TouchpointSerializer,
    follow_up_dict,
)
from .timeline import crm_activity, entity_timeline

CONTACT_FILTER_KEYS = (
    "relationship",
    "kind",
    "owner",
    "company",
    "search",
    "no_next_step",
    "overdue",
)
DEAL_FILTER_KEYS = ("pipeline", "stage", "status", "entity", "owner", "search")


def _filters(request, keys) -> dict[str, str]:
    out = {k: request.query_params[k] for k in keys if k in request.query_params}
    if out.get("owner") == "me":
        out["owner"] = str(request.user.pk)
    return out


def _guard(fn, *args, **kwargs):
    """Surface a refused write as a 400 rather than a 500."""
    try:
        return fn(*args, **kwargs)
    except services.CrmError as exc:
        raise ValidationError({"detail": str(exc)})


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------


def contact_detail(entity: Entity, request) -> dict:
    ctx = {"request": request}
    fresh = base_contact_queryset().get(pk=entity.pk)
    data = dict(ContactSerializer(fresh, context=ctx).data)
    if fresh.kind == EntityKind.COMPANY:
        people = filter_contacts({"relationship": "any", "company": fresh.pk}, sort="name")
        data["people"] = ContactSerializer(people, many=True, context=ctx).data
    else:
        data["people"] = []
    data["deals"] = DealSerializer(
        filter_deals({"entity": fresh.pk}), many=True, context=ctx
    ).data
    data["follow_ups"] = [
        follow_up_dict(f, context=ctx) for f in open_follow_ups({"entity": fresh.pk})
    ]
    data["meeting_count"] = (
        fresh.meetings.filter(entity_links__role=EntityRole.ATTENDEE).distinct().count()
    )
    data["timeline"] = entity_timeline(fresh)
    return data


class ContactViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    """People and companies in the CRM — the ``meetings.Entity`` rows with a
    relationship. ``POST`` finds-or-creates by name (so it lands on the entity
    meetings already know); ``PATCH`` edits CRM fields, and setting
    ``relationship`` to ``""`` takes an entity back out of the CRM."""

    serializer_class = ContactSerializer
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        if self.action == "list":
            return filter_contacts(
                _filters(self.request, CONTACT_FILTER_KEYS),
                sort=self.request.query_params.get("sort"),
            )
        return base_contact_queryset()

    def retrieve(self, request, *args, **kwargs):
        return Response(contact_detail(self.get_object(), request))

    def create(self, request, *args, **kwargs):
        payload = ContactWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        if not payload.validated_data.get("name"):
            raise ValidationError({"name": "This field is required."})
        entity, created = _guard(services.create_contact, payload.validated_data)
        return Response(
            contact_detail(entity, request),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def partial_update(self, request, *args, **kwargs):
        entity = self.get_object()
        payload = ContactWriteSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        data.pop("kind", None)
        _guard(services.update_contact, entity, data)
        return Response(contact_detail(entity, request))

    @action(detail=False, methods=["get"])
    def facets(self, request):
        """Counts behind the relationship filter (CRM entities only)."""
        rows = (
            Entity.objects.exclude(relationship="")
            .values("relationship", "kind")
            .annotate(n=Count("id"))
        )
        return Response(list(rows))


# ---------------------------------------------------------------------------
# Follow-ups
# ---------------------------------------------------------------------------


class FollowUpInboxView(APIView):
    """``GET /api/crm/inbox/?tz=Asia/Qatar&owner=me`` — open follow-ups in
    Overdue / Today / This week / Later, plus in-CRM contacts with no next
    step. TM stores no per-user timezone, so the browser sends its own."""

    def get(self, request):
        tz = services.resolve_tz(request.query_params.get("tz"))
        filters = _filters(request, ("owner",))
        ctx = {"request": request}
        today, grouped = bucket_follow_ups(open_follow_ups(filters), tz)
        buckets = {
            name: [follow_up_dict(f, context=ctx) for f in rows]
            for name, rows in grouped.items()
        }

        stale = without_listed_companies_people(
            filter_contacts({"no_next_step": "1", **filters}, sort="last_contact")
        )
        return Response(
            {
                "today": today.isoformat(),
                "buckets": buckets,
                "no_next_step": ContactSerializer(stale, many=True, context=ctx).data,
            }
        )


class FollowUpViewSet(viewsets.GenericViewSet):
    queryset = FollowUp.objects.select_related("task__column", "task__project", "entity")

    def create(self, request):
        payload = FollowUpInputSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        task = _guard(
            services.create_follow_up,
            data["entity"],
            data["title"],
            user=request.user,
            due=data.get("due"),
            tz=data.get("tz"),
            deal=data.get("deal"),
            assignee=data.get("assignee"),
            description=data.get("description") or "",
        )
        return Response(
            follow_up_dict(task.crm_follow_up, context={"request": request}),
            status=status.HTTP_201_CREATED,
        )

    def _respond(self, follow_up):
        follow_up = self.get_queryset().get(pk=follow_up.pk)
        return Response(follow_up_dict(follow_up, context={"request": self.request}))

    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        follow_up = self.get_object()
        _guard(services.complete_follow_up, follow_up, user=request.user)
        return self._respond(follow_up)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        follow_up = self.get_object()
        _guard(services.reopen_follow_up, follow_up, user=request.user)
        return self._respond(follow_up)

    @action(detail=True, methods=["post"])
    def reschedule(self, request, pk=None):
        follow_up = self.get_object()
        _guard(
            services.reschedule_follow_up,
            follow_up,
            request.data.get("due"),
            user=request.user,
            tz=request.data.get("tz"),
        )
        return self._respond(follow_up)


# ---------------------------------------------------------------------------
# Touchpoints
# ---------------------------------------------------------------------------


class TouchpointViewSet(
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Log (``POST``), correct (``PATCH``) or delete a touchpoint / note."""

    queryset = Touchpoint.objects.prefetch_related("entities").select_related("deal")
    serializer_class = TouchpointSerializer

    def create(self, request):
        payload = TouchpointInputSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        entities = data.pop("entities")
        deal = data.pop("deal", None)
        if data.get("follow_up"):
            data["follow_up"] = dict(data["follow_up"])
        touchpoint, created, _task = _guard(
            services.log_touchpoint, data, entities, user=request.user, deal=deal
        )
        return Response(
            TouchpointSerializer(touchpoint).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def partial_update(self, request, *args, **kwargs):
        touchpoint = self.get_object()
        payload = TouchpointPatchSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        kwargs = {}
        if "entities" in data:
            kwargs["entities"] = data.pop("entities")
        if "deal" in data:
            kwargs["deal"] = data.pop("deal")
        _guard(services.update_touchpoint, touchpoint, data, **kwargs)
        fresh = self.get_queryset().get(pk=touchpoint.pk)
        return Response(TouchpointSerializer(fresh).data)

    def perform_destroy(self, instance):
        services.delete_touchpoint(instance)


class ActivityView(APIView):
    """``GET /api/crm/activity/?days=14`` — everything that happened with CRM
    contacts lately: meetings, touchpoints, closed follow-ups."""

    def get(self, request):
        try:
            days = int(request.query_params.get("days", 14))
        except ValueError:
            raise ValidationError({"days": "Must be a number."})
        return Response(crm_activity(days=min(days, 365)))


class SitePreviewView(APIView):
    """``GET /api/crm/site-preview/?url=acme.com`` — name + one-line
    description read off a company's website, for the edit dialog to offer.
    Stores nothing."""

    def get(self, request):
        try:
            return Response(preview_site(request.query_params.get("url", "")))
        except PreviewError as e:
            raise ValidationError({"url": str(e)})


# ---------------------------------------------------------------------------
# Deals
# ---------------------------------------------------------------------------


class DealViewSet(viewsets.ModelViewSet):
    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"
    serializer_class = DealSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        if self.action == "list":
            return filter_deals(_filters(self.request, DEAL_FILTER_KEYS))
        return base_deal_queryset()

    def _detail(self, deal, status_code=status.HTTP_200_OK):
        fresh = base_deal_queryset().get(pk=deal.pk)
        data = dict(DealSerializer(fresh, context={"request": self.request}).data)
        data["follow_ups"] = [
            follow_up_dict(f, context={"request": self.request})
            for f in fresh.follow_ups.select_related(
                "task__column", "entity__company", "deal"
            )
        ]
        data["touchpoints"] = TouchpointSerializer(
            fresh.touchpoints.prefetch_related("entities"), many=True
        ).data
        return Response(data, status=status_code)

    def retrieve(self, request, *args, **kwargs):
        return self._detail(self.get_object())

    def create(self, request, *args, **kwargs):
        payload = DealWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        if not data.get("title"):
            raise ValidationError({"title": "This field is required."})
        if not data.get("pipeline"):
            raise ValidationError({"pipeline": "This field is required."})
        deal = _guard(services.create_deal, data, user=request.user)
        return self._detail(deal, status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        deal = self.get_object()
        payload = DealWriteSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        _guard(services.update_deal, deal, payload.validated_data)
        return self._detail(deal)

    def perform_destroy(self, instance):
        services.delete_deal(instance)

    @action(detail=True, methods=["post"])
    def move(self, request, key=None):
        deal = self.get_object()
        stage = get_object_or_404(Stage, pk=request.data.get("stage"))
        index = request.data.get("index")
        _guard(
            services.move_deal,
            deal,
            stage,
            index=int(index) if index not in (None, "") else None,
        )
        return self._detail(deal)


# ---------------------------------------------------------------------------
# Pipelines
# ---------------------------------------------------------------------------


class PipelineViewSet(viewsets.ModelViewSet):
    serializer_class = PipelineSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return Pipeline.objects.prefetch_related("stages")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["stage_counts"] = dict(
            Deal.objects.values_list("stage_id").annotate(n=Count("id"))
        )
        return ctx

    def _respond(self, pipeline, status_code=status.HTTP_200_OK):
        fresh = self.get_queryset().get(pk=pipeline.pk)
        return Response(
            PipelineSerializer(fresh, context=self.get_serializer_context()).data,
            status=status_code,
        )

    def create(self, request, *args, **kwargs):
        stages = StageSpecSerializer(data=request.data.get("stages") or [], many=True)
        stages.is_valid(raise_exception=True)
        pipeline = _guard(
            services.create_pipeline,
            request.data.get("name", ""),
            [dict(s) for s in stages.validated_data] or None,
        )
        return self._respond(pipeline, status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        raise ValidationError({"detail": "Use PATCH for the name and PUT …/stages/."})

    def partial_update(self, request, *args, **kwargs):
        pipeline = self.get_object()
        _guard(services.rename_pipeline, pipeline, request.data.get("name", ""))
        return self._respond(pipeline)

    def perform_destroy(self, instance):
        _guard(services.delete_pipeline, instance)

    @action(detail=True, methods=["put"])
    def stages(self, request, pk=None):
        pipeline = self.get_object()
        stages = StageSpecSerializer(data=request.data.get("stages"), many=True)
        stages.is_valid(raise_exception=True)
        _guard(services.set_stages, pipeline, [dict(s) for s in stages.validated_data])
        return self._respond(pipeline)
