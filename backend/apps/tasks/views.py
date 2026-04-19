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
    StaleThresholdConfig,
    Task,
    TransitionSource,
    View,
)
from .query import base_task_queryset, filter_and_sort_tasks
from .transitions import (
    invalidate_stale_thresholds,
    record_transition,
)
from .serializers import (
    ColumnSerializer,
    CsrfResponseSerializer,
    LabelSerializer,
    LoginRequestSerializer,
    ProjectSerializer,
    RecurringPreviewSerializer,
    RecurringTaskTemplateReadSerializer,
    RecurringTaskTemplateWriteSerializer,
    StalenessSettingsSerializer,
    StateTransitionSerializer,
    TaskMoveSerializer,
    TaskReadSerializer,
    TaskWriteSerializer,
    UserSerializer,
    ViewSerializer,
)
from .transitions import get_stale_thresholds
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
        return Response(UserSerializer(user, context={"request": request}).data)


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
        return Response(
            UserSerializer(request.user, context={"request": request}).data
        )

    @extend_schema(
        request={
            "application/json": {
                "type": "object",
                "properties": {"avatar_url": {"type": "string"}},
            },
            "multipart/form-data": {
                "type": "object",
                "properties": {
                    "avatar_image": {"type": "string", "format": "binary"},
                    "avatar_url": {"type": "string"},
                },
            },
        }
    )
    def patch(self, request):
        if not request.user.is_authenticated:
            return Response(
                {"detail": "Not authenticated."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        from .models import UserProfile

        profile, _ = UserProfile.objects.get_or_create(user=request.user)

        avatar_image = request.FILES.get("avatar_image")
        if avatar_image is not None:
            _validate_uploaded_image(avatar_image)
            # Clearing the URL keeps `effective_avatar_url` coherent: once a
            # user uploads a file, the URL column no longer represents them.
            profile.avatar_image = avatar_image
            profile.avatar_url = ""
            profile.save(update_fields=["avatar_image", "avatar_url"])

        avatar_url = request.data.get("avatar_url")
        if avatar_url is not None and avatar_image is None:
            profile.avatar_url = avatar_url
            # Replacing with an external URL discards any prior uploaded file
            # so the effective-url logic picks the URL.
            if profile.avatar_image:
                profile.avatar_image.delete(save=False)
                profile.avatar_image = None
            profile.save(update_fields=["avatar_url", "avatar_image"])

        return Response(
            UserSerializer(request.user, context={"request": request}).data
        )


# ---------------------------------------------------------------------------
# Image upload endpoint (task description images, etc.)
# ---------------------------------------------------------------------------

_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
_UPLOAD_ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp", "svg"}


def _validate_uploaded_image(file_obj) -> None:
    if file_obj.size > _UPLOAD_MAX_BYTES:
        raise ValidationError({"file": "Image must be ≤ 10 MB."})
    ctype = (file_obj.content_type or "").lower()
    if not ctype.startswith("image/"):
        raise ValidationError({"file": "Only image uploads are allowed."})
    name = (file_obj.name or "").lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    if ext not in _UPLOAD_ALLOWED_EXT:
        raise ValidationError({"file": f"Unsupported file extension: .{ext}"})


class UploadImageView(APIView):
    """Accept a single image file, persist to MEDIA_ROOT, return its URL.

    The description editor posts here when the user picks a file, pastes an
    image, or drops one onto the editor. Tasks don't get a dedicated
    Attachment model in Phase 1 — the returned URL is embedded directly in
    the task description's TipTap JSON.
    """

    serializer_class = None

    @extend_schema(
        request={
            "multipart/form-data": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "format": "binary"},
                },
                "required": ["file"],
            }
        },
        responses={
            201: {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "name": {"type": "string"},
                    "size": {"type": "integer"},
                },
            }
        },
    )
    def post(self, request):
        file_obj = request.FILES.get("file")
        if file_obj is None:
            raise ValidationError({"file": "No file provided."})
        _validate_uploaded_image(file_obj)

        import os
        import uuid

        from django.conf import settings
        from django.core.files.storage import default_storage

        ext = file_obj.name.rsplit(".", 1)[-1].lower()
        rel_path = os.path.join(
            "uploads", str(request.user.id), f"{uuid.uuid4().hex}.{ext}"
        )
        saved_path = default_storage.save(rel_path, file_obj)
        # default_storage.url() returns a relative /media/... path. The
        # frontend is on a different origin, so hand back an absolute URL.
        rel_url = default_storage.url(saved_path)
        absolute = request.build_absolute_uri(rel_url)
        return Response(
            {
                "url": absolute,
                "name": file_obj.name,
                "size": file_obj.size,
            },
            status=status.HTTP_201_CREATED,
        )


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
# Staleness settings (global singleton)
# ---------------------------------------------------------------------------


class StalenessSettingsView(APIView):
    """GET/PATCH the global stale-threshold config.

    Readable by any authenticated user (so the frontend can render badges);
    only editable by staff so a regular user can't accidentally turn
    staleness off for the whole team.
    """

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = StalenessSettingsSerializer

    @extend_schema(responses=StalenessSettingsSerializer)
    def get(self, request):
        from .models import DEFAULT_STALE_THRESHOLDS

        config = StaleThresholdConfig.load()
        return Response(
            {
                "thresholds": config.thresholds or {},
                "defaults": DEFAULT_STALE_THRESHOLDS,
                "updated_at": config.updated_at,
            }
        )

    @extend_schema(
        request=StalenessSettingsSerializer, responses=StalenessSettingsSerializer
    )
    def patch(self, request):
        if not request.user.is_staff:
            return Response(
                {"detail": "Only staff can change staleness settings."},
                status=status.HTTP_403_FORBIDDEN,
            )
        payload = StalenessSettingsSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        thresholds = payload.validated_data.get("thresholds") or {}
        if not isinstance(thresholds, dict):
            raise ValidationError({"thresholds": "Must be an object."})

        # Light validation: each value must be a dict; days must be
        # non-negative integers if present. Unknown keys pass through.
        for col_name, rules in thresholds.items():
            if not isinstance(rules, dict):
                raise ValidationError(
                    {col_name: "Expected an object with yellow_days/red_days."}
                )
            for key in ("yellow_days", "red_days"):
                if key in rules and rules[key] is not None:
                    value = rules[key]
                    if not isinstance(value, int) or value < 0:
                        raise ValidationError(
                            {col_name: f"{key} must be a non-negative integer."}
                        )

        config = StaleThresholdConfig.load()
        config.thresholds = thresholds
        config.save(update_fields=["thresholds", "updated_at"])
        invalidate_stale_thresholds()
        return Response({"thresholds": config.thresholds})


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
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["archived"]

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

    @action(detail=True, methods=["post"])
    def star(self, request, pk=None):
        """Star this project for the current user."""
        from .models import UserProfile

        project = self.get_object()
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        profile.starred_projects.add(project)
        serializer = self.get_serializer(project)
        return Response(serializer.data)

    @action(detail=True, methods=["post"])
    def unstar(self, request, pk=None):
        """Unstar this project for the current user."""
        from .models import UserProfile

        project = self.get_object()
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        profile.starred_projects.remove(project)
        serializer = self.get_serializer(project)
        return Response(serializer.data)


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
        if self.action in {"list", "retrieve", "move"}:
            return TaskReadSerializer
        return TaskWriteSerializer

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # Load staleness thresholds once per request so each task's
        # ``staleness`` SerializerMethodField doesn't hit the in-process
        # cache individually.
        ctx["staleness_thresholds"] = get_stale_thresholds()
        return ctx

    def perform_create(self, serializer):
        task = serializer.save(reporter=self.request.user)
        if task.column_id:
            record_transition(
                task,
                from_column=None,
                to_column=task.column,
                user=self.request.user,
                source=TransitionSource.USER,
            )
        broadcast_task_event(
            task.project_id, "task.created", {"key": task.key, "id": task.id}
        )

    def perform_update(self, serializer):
        # Capture old column before the update so we can record the
        # transition if the PATCH changed it.
        instance = serializer.instance
        old_column = instance.column if instance else None
        task = serializer.save()
        if task.column_id != (old_column.id if old_column else None):
            record_transition(
                task,
                from_column=old_column,
                to_column=task.column,
                user=self.request.user,
                source=TransitionSource.USER,
            )
        broadcast_task_event(
            task.project_id, "task.updated", {"key": task.key, "id": task.id}
        )

    def perform_destroy(self, instance):
        project_id = instance.project_id
        key = instance.key
        instance.delete()
        broadcast_task_event(project_id, "task.deleted", {"key": key})

    @action(
        detail=True,
        methods=["get"],
        url_path="transitions",
        serializer_class=StateTransitionSerializer,
    )
    def transitions(self, request, key=None):
        """Return the ordered state-transition log for a task."""
        task = self.get_object()
        qs = (
            task.transitions.all()
            .select_related("from_column", "to_column", "triggered_by")
            .order_by("at", "id")
        )
        return Response(StateTransitionSerializer(qs, many=True).data)

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

        old_column = task.column
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
            if (old_column.id if old_column else None) != column.id:
                record_transition(
                    task,
                    from_column=old_column,
                    to_column=column,
                    user=request.user,
                    source=TransitionSource.USER,
                )

        broadcast_task_event(
            task.project_id,
            "task.moved",
            {"key": task.key, "id": task.id, "column_id": column.id},
        )
        # Re-fetch through ``get_queryset`` so the ``current_column_since``
        # annotation is populated for the response.
        fresh = self.get_queryset().get(pk=task.pk)
        return Response(
            TaskReadSerializer(fresh, context=self.get_serializer_context()).data
        )


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
