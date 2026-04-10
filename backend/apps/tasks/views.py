"""DRF viewsets and auth endpoints for the task tracker."""

from __future__ import annotations

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.db import models, transaction
from django.db.models import Max, Min
from django.middleware.csrf import get_token
from django.utils import timezone
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .broadcast import _broadcast_local, broadcast_task_event
from .filters import TaskFilter
from .models import (
    Column,
    Label,
    Project,
    RecurringTaskTemplate,
    Task,
    View,
)
from .query import base_task_queryset, filter_and_sort_tasks
from .serializers import (
    ColumnSerializer,
    CsrfResponseSerializer,
    LabelSerializer,
    LoginRequestSerializer,
    ProjectSerializer,
    RecurringPreviewSerializer,
    RecurringTaskTemplateReadSerializer,
    RecurringTaskTemplateWriteSerializer,
    TaskMoveSerializer,
    TaskReadSerializer,
    TaskWriteSerializer,
    UserSerializer,
    ViewSerializer,
)
from drf_spectacular.utils import extend_schema

User = get_user_model()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@extend_schema(responses=CsrfResponseSerializer)
@api_view(["GET"])
@permission_classes([permissions.AllowAny])
def csrf_view(request):
    """Seeds the CSRF cookie. The frontend calls this once on boot."""
    return Response({"csrfToken": get_token(request)})


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]
    serializer_class = LoginRequestSerializer

    @extend_schema(request=LoginRequestSerializer, responses=UserSerializer)
    def post(self, request):
        payload = LoginRequestSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        user = authenticate(
            request,
            username=payload.validated_data["username"],
            password=payload.validated_data["password"],
        )
        if user is None:
            return Response(
                {"detail": "Invalid credentials."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        login(request, user)
        return Response(UserSerializer(user).data)


class LogoutView(APIView):
    serializer_class = None

    @extend_schema(request=None, responses={204: None})
    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    # AllowAny so DRF doesn't short-circuit with a 403 — we want to return
    # a clean 401 from inside the view when the session is missing. The
    # frontend uses that signal to redirect to /login.
    permission_classes = [permissions.AllowAny]
    serializer_class = UserSerializer

    @extend_schema(responses=UserSerializer)
    def get(self, request):
        if not request.user.is_authenticated:
            return Response(
                {"detail": "Not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        return Response(UserSerializer(request.user).data)

    @extend_schema(request={"application/json": {"type": "object", "properties": {"avatar_url": {"type": "string"}}}})
    def patch(self, request):
        if not request.user.is_authenticated:
            return Response(
                {"detail": "Not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        from .models import UserProfile

        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        avatar_url = request.data.get("avatar_url")
        if avatar_url is not None:
            profile.avatar_url = avatar_url
            profile.save(update_fields=["avatar_url"])
        return Response(UserSerializer(request.user).data)


@api_view(["POST"])
@permission_classes([permissions.AllowAny])
def internal_broadcast(request):
    """Cross-process broadcast bridge.

    The MCP server runs in a separate process, which means its in-memory
    channel layer is disjoint from daphne's. It POSTs here instead so the
    broadcast lands in daphne's channel layer (where browser WebSockets are
    actually subscribed). Authenticated by a shared secret header; refuses
    non-loopback callers as a second line of defence.
    """
    from django.conf import settings

    host = request.META.get("REMOTE_ADDR", "")
    if host not in ("127.0.0.1", "::1"):
        return Response(
            {"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN
        )

    provided = request.META.get("HTTP_X_CYT_BROADCAST_SECRET", "")
    if provided != getattr(settings, "CYT_BROADCAST_SECRET", ""):
        return Response(
            {"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN
        )

    data = request.data or {}
    project_id = data.get("project_id")
    event_type = data.get("type")
    payload = data.get("payload") or {}
    if not isinstance(project_id, int) or not isinstance(event_type, str):
        return Response(
            {"detail": "Invalid payload."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    _broadcast_local(project_id, event_type, payload)
    return Response({"ok": True})


# ---------------------------------------------------------------------------
# Read-only reference data
# ---------------------------------------------------------------------------


class UserViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = User.objects.filter(is_active=True).order_by("username")
    serializer_class = UserSerializer
    pagination_class = None  # small set, always return all


class ProjectViewSet(viewsets.ModelViewSet):
    queryset = Project.objects.all().prefetch_related("columns")
    serializer_class = ProjectSerializer

    @action(detail=True, methods=["get"])
    def columns(self, request, pk=None):
        project = self.get_object()
        return Response(
            ColumnSerializer(project.columns.order_by("order"), many=True).data
        )

    @action(detail=True, methods=["get"], url_path="labels")
    def labels_action(self, request, pk=None):
        project = self.get_object()
        # Include both project-specific and global labels
        labels = Label.objects.filter(
            models.Q(project=project) | models.Q(project__isnull=True)
        ).order_by("project_id", "name")
        return Response(LabelSerializer(labels, many=True).data)


class ColumnViewSet(viewsets.ModelViewSet):
    queryset = Column.objects.all().order_by("project_id", "order")
    serializer_class = ColumnSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project"]


class LabelViewSet(viewsets.ModelViewSet):
    queryset = Label.objects.all().order_by("project_id", "name")
    serializer_class = LabelSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project"]


# ---------------------------------------------------------------------------
# Tasks — the hot path
# ---------------------------------------------------------------------------


class TaskViewSet(viewsets.ModelViewSet):
    """All task CRUD. Lookup is by the human key (``CYT-001``)."""

    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"
    filter_backends = [DjangoFilterBackend]
    filterset_class = TaskFilter

    def get_queryset(self):
        qs = base_task_queryset()
        view_id = self.request.query_params.get("view")
        if view_id:
            try:
                saved = View.objects.get(pk=view_id)
            except View.DoesNotExist as e:
                raise NotFound("Saved view not found.") from e
            if not saved.shared and saved.owner_id != self.request.user.id:
                raise NotFound("Saved view not found.")
            qs = filter_and_sort_tasks(
                saved.filters,
                saved.sort,
                requesting_user=self.request.user,
                base=qs,
            )
        return qs

    def get_serializer_class(self):
        if self.action in {"list", "retrieve"}:
            return TaskReadSerializer
        return TaskWriteSerializer

    def perform_create(self, serializer):
        task = serializer.save(reporter=self.request.user)
        broadcast_task_event(
            task.project_id, "task.created", {"key": task.key, "id": task.id}
        )

    def perform_update(self, serializer):
        task = serializer.save()
        broadcast_task_event(
            task.project_id, "task.updated", {"key": task.key, "id": task.id}
        )

    def perform_destroy(self, instance):
        project_id = instance.project_id
        key = instance.key
        instance.delete()
        broadcast_task_event(project_id, "task.deleted", {"key": key})

    @action(detail=True, methods=["post"], serializer_class=TaskMoveSerializer)
    def move(self, request, key=None):
        """Atomically move a task to a new column + position.

        Accepts either an explicit ``position`` float, or ``before_id`` /
        ``after_id`` to compute midpoint positioning. When neither is given,
        the task lands at the bottom of the target column.
        """
        task = self.get_object()
        payload = TaskMoveSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        try:
            column = Column.objects.get(pk=data["column_id"])
        except Column.DoesNotExist as e:
            raise ValidationError({"column_id": "Column not found."}) from e
        if column.project_id != task.project_id:
            raise ValidationError(
                {"column_id": "Column does not belong to the task's project."}
            )

        with transaction.atomic():
            task.column = column
            if data.get("position") is not None:
                task.position = float(data["position"])
            else:
                before_id = data.get("before_id")
                after_id = data.get("after_id")
                task.position = _compute_position(
                    column=column,
                    before_id=before_id,
                    after_id=after_id,
                    task_id=task.id,
                )
            task.save(update_fields=["column", "position", "updated_at"])

        broadcast_task_event(
            task.project_id,
            "task.moved",
            {"key": task.key, "id": task.id, "column_id": column.id},
        )
        return Response(TaskReadSerializer(task).data)


def _compute_position(
    *, column: Column, before_id: int | None, after_id: int | None, task_id: int
) -> float:
    """Midpoint positioning for drag-and-drop.

    - ``after_id`` is the task that should sit *above* the dragged one in the
      new column (i.e. the new position is between ``after_id`` and the task
      below it).
    - ``before_id`` is the task that should sit *below* the dragged one.
    - When both are given we average them.
    - When only one is given we offset by a constant.
    - When neither is given we append to the bottom.
    """
    neighbors = column.tasks.exclude(id=task_id)

    after = neighbors.filter(id=after_id).first() if after_id else None
    before = neighbors.filter(id=before_id).first() if before_id else None

    if after and before:
        return (after.position + before.position) / 2.0
    if after and not before:
        bigger = neighbors.filter(position__gt=after.position).aggregate(
            m=Min("position")
        )["m"]
        if bigger is None:
            return after.position + 1000.0
        return (after.position + bigger) / 2.0
    if before and not after:
        smaller = neighbors.filter(position__lt=before.position).aggregate(
            m=Max("position")
        )["m"]
        if smaller is None:
            return before.position - 1000.0
        return (smaller + before.position) / 2.0
    # Append to bottom.
    tail = neighbors.aggregate(m=Max("position"))["m"]
    return (tail or 0) + 1000.0


# ---------------------------------------------------------------------------
# Saved views
# ---------------------------------------------------------------------------


class ViewViewSet(viewsets.ModelViewSet):
    serializer_class = ViewSerializer
    queryset = View.objects.none()  # schema-gen hint; real queryset comes from get_queryset

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return View.objects.none()
        user = self.request.user
        return (
            View.objects.filter(owner=user) | View.objects.filter(shared=True)
        ).distinct().order_by("name")

    def perform_update(self, serializer):
        view = self.get_object()
        if view.owner_id != self.request.user.id:
            raise ValidationError("You can only edit your own views.")
        serializer.save()

    def perform_destroy(self, instance):
        if instance.owner_id != self.request.user.id:
            raise ValidationError("You can only delete your own views.")
        instance.delete()


# ---------------------------------------------------------------------------
# Recurring task templates
# ---------------------------------------------------------------------------


class RecurringTaskViewSet(viewsets.ModelViewSet):
    queryset = (
        RecurringTaskTemplate.objects.all()
        .select_related("project", "column", "assignee", "created_by")
        .prefetch_related("labels")
    )
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project", "active"]

    def get_serializer_class(self):
        if self.action in {"list", "retrieve"}:
            return RecurringTaskTemplateReadSerializer
        return RecurringTaskTemplateWriteSerializer

    @action(detail=True, methods=["post"])
    def pause(self, request, pk=None):
        template = self.get_object()
        template.active = False
        template.save(update_fields=["active", "updated_at"])
        return Response(RecurringTaskTemplateReadSerializer(template).data)

    @action(detail=True, methods=["post"])
    def resume(self, request, pk=None):
        from .recurring import compute_initial_next_run

        template = self.get_object()
        template.active = True
        if template.next_run_at < timezone.now():
            template.next_run_at = compute_initial_next_run(
                template.rrule, template.dtstart
            )
        template.save(update_fields=["active", "next_run_at", "updated_at"])
        return Response(RecurringTaskTemplateReadSerializer(template).data)

    @action(detail=True, methods=["post"])
    def preview(self, request, pk=None):
        from .recurring import preview_occurrences

        template = self.get_object()
        payload = RecurringPreviewSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        count = payload.validated_data["count"]
        occurrences = preview_occurrences(template, count=count)
        return Response(
            {
                "template_id": template.id,
                "occurrences": [dt.isoformat() for dt in occurrences],
            }
        )
