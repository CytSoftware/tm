"""REST API for the CRM (mounted at ``/api/crm/``).

Auth is the project default (session + ``IsAuthenticated``; staff-only via
``NonStaffAccessMiddleware``). All filtering goes through ``query.py`` and all
writes through ``services.py`` — the MCP tools use the same two modules.
"""

from __future__ import annotations

from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.meetings.models import EntityKind, EntityRole
from django.shortcuts import get_object_or_404

from apps.tasks.models import Project, Task

from . import services
from .models import Lead, Update
from .query import (
    base_contact_queryset,
    base_lead_queryset,
    filter_contacts,
    filter_leads,
    filter_updates,
    lead_people,
    open_steps,
)
from .serializers import (
    ContactSerializer,
    ContactWriteSerializer,
    LeadSerializer,
    LeadWriteSerializer,
    UpdateInputSerializer,
    entity_ref,
    step_dict,
    update_dict,
)

CONTACT_FILTER_KEYS = ("kind", "company", "search", "project", "all")
LEAD_FILTER_KEYS = ("stage", "status", "entity", "project", "search")
THREAD_LIMIT = 200


def _filters(request, keys) -> dict[str, str]:
    return {k: request.query_params[k] for k in keys if k in request.query_params}


def _guard(fn, *args, **kwargs):
    """Surface a refused write as a 400 rather than a 500."""
    try:
        return fn(*args, **kwargs)
    except services.CrmError as exc:
        raise ValidationError({"detail": str(exc)})


def _updates(filters, request) -> list[dict]:
    ctx = {"request": request}
    return [update_dict(u, context=ctx) for u in filter_updates(filters)[:THREAD_LIMIT]]


# ---------------------------------------------------------------------------
# People & companies
# ---------------------------------------------------------------------------


def contact_detail(entity, request) -> dict:
    ctx = {"request": request}
    fresh = base_contact_queryset().get(pk=entity.pk)
    data = dict(ContactSerializer(fresh, context=ctx).data)
    data["people"] = (
        ContactSerializer(
            base_contact_queryset().filter(company=fresh).order_by("name"), many=True, context=ctx
        ).data
        if fresh.kind == EntityKind.COMPANY
        else []
    )
    data["leads"] = LeadSerializer(filter_leads({"entity": fresh.pk}), many=True, context=ctx).data
    data["updates"] = _updates({"entity": fresh.pk}, request)
    data["meeting_count"] = (
        fresh.meetings.filter(entity_links__role=EntityRole.ATTENDEE).distinct().count()
    )
    return data


class ContactViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """People and companies. The list defaults to the ones in the CRM (on a
    lead or an update); ``?search=`` or ``?all=1`` covers everyone meetings
    know. ``POST`` finds-or-creates by name, so it lands on the entity a
    recording already created."""

    serializer_class = ContactSerializer
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        if self.action == "list":
            return filter_contacts(_filters(self.request, CONTACT_FILTER_KEYS))
        return base_contact_queryset()

    def retrieve(self, request, *args, **kwargs):
        return Response(contact_detail(self.get_object(), request))

    def create(self, request, *args, **kwargs):
        payload = ContactWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
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


# ---------------------------------------------------------------------------
# Leads
# ---------------------------------------------------------------------------


class LeadViewSet(viewsets.ModelViewSet):
    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"
    serializer_class = LeadSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        if self.action == "list":
            return filter_leads(_filters(self.request, LEAD_FILTER_KEYS))
        return base_lead_queryset()

    def _detail(self, lead, status_code=status.HTTP_200_OK):
        ctx = {"request": self.request}
        fresh = base_lead_queryset().get(pk=lead.pk)
        data = dict(LeadSerializer(fresh, context=ctx).data)
        data["people"] = [entity_ref(p) for p in lead_people(fresh)]
        steps = open_steps().filter(crm_update__lead=fresh).select_related("column")
        data["steps"] = [step_dict(t, context=ctx) for t in steps.prefetch_related("assignees")]
        data["updates"] = _updates({"lead": fresh.key}, self.request)
        return Response(data, status=status_code)

    def retrieve(self, request, *args, **kwargs):
        return self._detail(self.get_object())

    def create(self, request, *args, **kwargs):
        payload = LeadWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        lead = _guard(services.create_lead, payload.validated_data, user=request.user)
        return self._detail(lead, status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        lead = self.get_object()
        payload = LeadWriteSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        _guard(services.update_lead, lead, payload.validated_data)
        return self._detail(lead)

    def perform_destroy(self, instance):
        services.delete_lead(instance)

    @action(detail=True, methods=["post"])
    def move(self, request, key=None):
        lead = self.get_object()
        index = request.data.get("index")
        _guard(
            services.move_lead,
            lead,
            str(request.data.get("stage") or ""),
            index=int(index) if index not in (None, "") else None,
        )
        return self._detail(lead)


class StepView(APIView):
    """``POST /api/crm/steps/<task key>/ {"done": true}`` — tick a next step
    off or reopen it."""

    def post(self, request, key):
        task = get_object_or_404(
            Task.objects.select_related("column", "project"), key__iexact=key, crm_update__isnull=False
        )
        _guard(services.set_step_done, task, bool(request.data.get("done")), user=request.user)
        task.refresh_from_db()
        return Response(step_dict(task, context={"request": request}))


# ---------------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------------


class UpdateViewSet(mixins.DestroyModelMixin, viewsets.GenericViewSet):
    """Post (``POST``), correct (``PATCH``) or delete an update."""

    queryset = Update.objects.all()

    def _respond(self, update, status_code=status.HTTP_200_OK):
        fresh = filter_updates().get(pk=update.pk)
        return Response(update_dict(fresh, context={"request": self.request}), status=status_code)

    def create(self, request):
        payload = UpdateInputSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        update = _guard(
            services.post_update,
            data,
            user=request.user,
            lead=data.pop("lead", None),
            people=data.pop("people", []),
            # Default "with" is the author — they were on it.
            users=data.pop("users", [request.user]),
            meeting=data.pop("meeting", None),
        )
        return self._respond(update, status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        update = self.get_object()
        payload = UpdateInputSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        for k in ("next_step", "next_due", "next_assignee", "tz"):
            data.pop(k, None)
        kwargs = {k: data.pop(k) for k in ("lead", "people", "users", "meeting") if k in data}
        _guard(services.edit_update, update, data, **kwargs)
        return self._respond(update)

    def perform_destroy(self, instance):
        services.delete_update(instance)


class ActivityView(APIView):
    """``GET /api/crm/activity/?days=30&project=MOW`` — every update, newest
    first."""

    def get(self, request):
        try:
            days = min(int(request.query_params.get("days", 30)), 365)
        except ValueError:
            raise ValidationError({"days": "Must be a number."})
        return Response(
            _updates({"days": days, "project": request.query_params.get("project")}, request)
        )


class CrmProjectsView(APIView):
    """``GET /api/crm/projects/`` — projects that have leads: the scope
    switcher's options."""

    def get(self, request):
        projects = Project.objects.filter(crm_leads__isnull=False).distinct().order_by("name")
        return Response(
            [{"id": p.id, "prefix": p.prefix, "name": p.name, "color": p.color} for p in projects]
        )
