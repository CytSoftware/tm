"""REST API for the CRM (mounted at ``/api/crm/``).

Auth is the project default (session + ``IsAuthenticated``). Non-staff need
the ``crm`` module (``billing`` for payments and licences, either for contacts)
— ``ModuleAccessMiddleware`` — and every queryset here is scoped to the
caller's projects through ``query.py``'s ``user`` argument, detail routes
included. All writes go through ``services.py``, whose ``check_reach``
refuses references the caller can't see. The MCP tools use the same modules.
"""

from __future__ import annotations

from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.meetings.models import Entity, EntityKind, EntityRole
from django.shortcuts import get_object_or_404

from apps.tasks.access import has_module, restrict_to_projects, visible_project_ids
from apps.tasks.models import Project, Task

from . import services
from .models import Lead, Licence, Payment, Update
from .query import (
    annotate_contacts,
    base_contact_queryset,
    base_lead_queryset,
    base_update_queryset,
    filter_contacts,
    filter_leads,
    filter_licences,
    filter_payments,
    filter_updates,
    lead_people,
    open_steps,
)
from .serializers import (
    ContactSerializer,
    ContactWriteSerializer,
    LeadSerializer,
    LeadWriteSerializer,
    LicenceWriteSerializer,
    PaymentWriteSerializer,
    UpdateInputSerializer,
    entity_ref,
    licence_dict,
    payment_dict,
    step_dict,
    update_dict,
)

CONTACT_FILTER_KEYS = ("kind", "company", "search", "project", "all")
LEAD_FILTER_KEYS = ("stage", "status", "entity", "project", "search")
PAYMENT_FILTER_KEYS = ("status", "type", "project", "company", "lead", "licence")
LICENCE_FILTER_KEYS = ("status", "project", "company", "lead")
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
    rows = filter_updates(filters, user=request.user)[:THREAD_LIMIT]
    return [update_dict(u, context=ctx) for u in rows]


# ---------------------------------------------------------------------------
# People & companies
# ---------------------------------------------------------------------------


def contact_detail(entity, request) -> dict:
    ctx = {"request": request}
    user = request.user
    fresh = base_contact_queryset(user=user).get(pk=entity.pk)
    data = dict(ContactSerializer(fresh, context=ctx).data)
    data["people"] = (
        ContactSerializer(
            base_contact_queryset(user=user).filter(company=fresh).order_by("name"),
            many=True,
            context=ctx,
        ).data
        if fresh.kind == EntityKind.COMPANY
        else []
    )
    leads = filter_leads({"entity": fresh.pk}, user=user)
    data["leads"] = LeadSerializer(leads, many=True, context=ctx).data
    data["updates"] = _updates({"entity": fresh.pk}, request)
    meetings = restrict_to_projects(fresh.meetings.all(), user, "meetings")
    data["meeting_count"] = (
        meetings.filter(entity_links__role=EntityRole.ATTENDEE).distinct().count()
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
            return filter_contacts(_filters(self.request, CONTACT_FILTER_KEYS), user=self.request.user)
        return base_contact_queryset(user=self.request.user)

    def retrieve(self, request, *args, **kwargs):
        return Response(contact_detail(self.get_object(), request))

    def create(self, request, *args, **kwargs):
        payload = ContactWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        entity, created = _guard(
            services.create_contact, payload.validated_data, viewer=request.user
        )
        if not base_contact_queryset(user=request.user).filter(pk=entity.pk).exists():
            # Not on one of their leads yet (a new contact, or someone only
            # meetings know): it shows in their CRM once it is. Until then
            # they get the bare entity — no one else's details or history.
            row = annotate_contacts(
                Entity.objects.select_related("company").filter(pk=entity.pk), user=request.user
            ).get()
            data = dict(ContactSerializer(row, context={"request": request}).data)
            if not created:
                data.update(emails=[], phone="", linkedin_url="")
            return Response(
                {**data, "people": [], "leads": [], "updates": [], "meeting_count": 0},
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )
        return Response(
            contact_detail(entity, request),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def partial_update(self, request, *args, **kwargs):
        if not has_module(request.user, "crm"):
            # Billing may pick and create companies, not edit contacts.
            raise PermissionDenied("You don't have access to this.")
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
            return filter_leads(_filters(self.request, LEAD_FILTER_KEYS), user=self.request.user)
        return base_lead_queryset(user=self.request.user)

    def _detail(self, lead, status_code=status.HTTP_200_OK):
        ctx = {"request": self.request}
        fresh = base_lead_queryset(user=self.request.user).get(pk=lead.pk)
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
        data = payload.validated_data
        _guard(
            services.check_reach, request.user, "crm",
            project=data.get("project"), entities=[data.get("company")],
        )
        lead = _guard(services.create_lead, data, user=request.user)
        return self._detail(lead, status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        lead = self.get_object()
        payload = LeadWriteSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        _guard(
            services.check_reach, request.user, "crm",
            project=data["project"] if "project" in data else services.UNSET,
            entities=[data.get("company")],
        )
        _guard(services.update_lead, lead, data)
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
        steps = restrict_to_projects(
            Task.objects.select_related("column", "project"), request.user, "crm",
            "crm_update__lead__project",
        )
        task = get_object_or_404(steps, key__iexact=key, crm_update__isnull=False)
        _guard(services.set_step_done, task, bool(request.data.get("done")), user=request.user)
        task.refresh_from_db()
        return Response(step_dict(task, context={"request": request}))


# ---------------------------------------------------------------------------
# Updates
# ---------------------------------------------------------------------------


class UpdateViewSet(mixins.DestroyModelMixin, viewsets.GenericViewSet):
    """Post (``POST``), correct (``PATCH``) or delete an update."""

    queryset = Update.objects.all()

    def get_queryset(self):
        return base_update_queryset(user=self.request.user)

    def _respond(self, update, status_code=status.HTTP_200_OK):
        fresh = filter_updates(user=self.request.user).get(pk=update.pk)
        return Response(update_dict(fresh, context={"request": self.request}), status=status_code)

    def create(self, request):
        payload = UpdateInputSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        _guard(
            services.check_reach, request.user, "crm",
            lead=data.get("lead"), lead_required=True, meeting=data.get("meeting"),
            entities=data.get("people", []),
        )
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
        _guard(
            services.check_reach, request.user, "crm",
            lead=kwargs.get("lead", update.lead), lead_required=True,
            meeting=kwargs.get("meeting"), entities=kwargs.get("people", []),
        )
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
        # Billing-only users get the projects they bill in instead.
        module = "crm" if has_module(request.user, "crm") else "billing"
        related = "crm_leads" if module == "crm" else "crm_payments"
        projects = Project.objects.filter(**{f"{related}__isnull": False})
        if (ids := visible_project_ids(request.user, module)) is not None:
            projects = projects.filter(pk__in=ids)
        projects = projects.distinct().order_by("name")
        return Response(
            [{"id": p.id, "prefix": p.prefix, "name": p.name, "color": p.color} for p in projects]
        )


# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------


class PaymentViewSet(viewsets.GenericViewSet):
    """``/api/crm/payments/`` — what customers owe us. List takes
    ``?status=paid|overdue|upcoming&type=&project=&company=&lead=``; status is
    derived from the dates."""

    queryset = Payment.objects.all()

    def get_queryset(self):
        return filter_payments(user=self.request.user)

    def _respond(self, payment, status_code=status.HTTP_200_OK):
        user = self.request.user
        row = filter_payments(user=user).get(pk=payment.pk)
        return Response(payment_dict(row, user=user), status=status_code)

    def list(self, request):
        rows = filter_payments(_filters(request, PAYMENT_FILTER_KEYS), user=request.user)
        return Response([payment_dict(p, user=request.user) for p in rows])

    def create(self, request):
        payload = PaymentWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        payment = _guard(
            services.save_payment, None, payload.validated_data, viewer=request.user
        )
        return self._respond(payment, status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        payment = self.get_object()
        payload = PaymentWriteSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        _guard(services.save_payment, payment, payload.validated_data, viewer=request.user)
        return self._respond(payment)

    def destroy(self, request, pk=None):
        services.delete_payment(self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)


class LicenceViewSet(viewsets.GenericViewSet):
    """``/api/crm/licences/`` — who is licensed for what, until when. Each row
    carries the derived status (upcoming / active / expiring / ended),
    ``renewed`` and the paid/total of its linked payments."""

    queryset = Licence.objects.all()

    def get_queryset(self):
        return filter_licences(user=self.request.user)

    def _respond(self, licence, status_code=status.HTTP_200_OK):
        user = self.request.user
        row = filter_licences(user=user).get(pk=licence.pk)
        return Response(licence_dict(row, user=user), status=status_code)

    def list(self, request):
        rows = filter_licences(_filters(request, LICENCE_FILTER_KEYS), user=request.user)
        return Response([licence_dict(lc, user=request.user) for lc in rows])

    def create(self, request):
        payload = LicenceWriteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        plan = data.pop("payments", [])
        licence = _guard(services.save_licence, None, data, plan=plan, viewer=request.user)
        return self._respond(licence, status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        licence = self.get_object()
        payload = LicenceWriteSerializer(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        data.pop("payments", None)
        _guard(services.save_licence, licence, data, viewer=request.user)
        return self._respond(licence)

    def destroy(self, request, pk=None):
        services.delete_licence(self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)
