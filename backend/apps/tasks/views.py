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
from .models import (
    Bet,
    Checkin,
    Column,
    Label,
    Metric,
    Notification,
    Project,
    RecurringTaskTemplate,
    StaleThresholdConfig,
    Task,
    TransitionEvent,
    TransitionSource,
    View,
)
from .notifications import notify_task_event
from .periods import current_period_start, period_start_for
from .query import base_task_queryset, filter_and_sort_tasks
from .transitions import (
    invalidate_stale_thresholds,
    record_transition,
)
from .serializers import (
    BetSerializer,
    CheckinSerializer,
    ColumnSerializer,
    CsrfResponseSerializer,
    LabelSerializer,
    LoginRequestSerializer,
    MetricSerializer,
    NotificationSerializer,
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
        return Response(_me_payload(user, request))


class LogoutView(APIView):
    serializer_class = None

    @extend_schema(request=None, responses={204: None})
    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


# Keys the frontend owns for other behaviors in the Assign-Todo dialog —
# rejected at bind-time so users can't stomp on skip/close.
_RESERVED_HOTKEYS: set[str] = {"ArrowDown", "Escape"}


def _me_payload(user, request):
    """Flat dict for /api/auth/me/ — UserSerializer fields plus a
    ``preferences`` object. Preferences live only on this endpoint; the
    shared ``/api/users/`` list intentionally stays lean."""
    from .models import UserProfile

    data = dict(UserSerializer(user, context={"request": request}).data)
    profile = getattr(user, "profile", None) or UserProfile.objects.get_or_create(user=user)[0]
    raw = profile.assign_hotkey_bindings or {}
    # Defensive filter so a hand-edited column can't crash the frontend.
    clean: dict[str, int] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            if not isinstance(k, str) or k in _RESERVED_HOTKEYS:
                continue
            try:
                clean[k] = int(v)
            except (TypeError, ValueError):
                continue
    data["preferences"] = {
        "assign_hotkey_bindings": clean,
        "board_column_prefs": _clean_board_column_prefs(profile.board_column_prefs),
    }
    return data


def _clean_board_column_prefs(raw) -> dict[str, dict[str, list[int]]]:
    """Defensive filter mirroring ``assign_hotkey_bindings`` above, so a
    hand-edited column can't crash the frontend. Drops anything that
    doesn't match ``{"<project_id>": {"hidden_columns": [<column_id>, ...]}}``.
    """
    clean: dict[str, dict[str, list[int]]] = {}
    if not isinstance(raw, dict):
        return clean
    for project_id, value in raw.items():
        if not isinstance(project_id, str) or not isinstance(value, dict):
            continue
        hidden = value.get("hidden_columns")
        if not isinstance(hidden, list):
            continue
        ids: list[int] = []
        for cid in hidden:
            try:
                ids.append(int(cid))
            except (TypeError, ValueError):
                continue
        clean[project_id] = {"hidden_columns": ids}
    return clean


def _validate_board_column_prefs(raw) -> dict[str, dict[str, list[int]]]:
    """Strict-validate a PATCH ``preferences.board_column_prefs`` payload.

    Unlike ``_clean_board_column_prefs`` (which silently drops malformed
    entries on read so a bad DB row can't crash the frontend), writes are
    rejected outright with a 400 so the frontend finds out immediately if
    it sends the wrong shape. Required shape:
    ``{"<project_id>": {"hidden_columns": [<column_id>, ...]}}`` where
    ``project_id`` is a string of digits and ``hidden_columns`` entries are
    (or losslessly stringify to) ints.
    """
    if not isinstance(raw, dict):
        raise ValidationError(
            {"preferences.board_column_prefs": "Must be an object."}
        )
    validated: dict[str, dict[str, list[int]]] = {}
    for project_id, value in raw.items():
        if not isinstance(project_id, str) or not project_id.isdigit():
            raise ValidationError(
                {"preferences.board_column_prefs": "Keys must be string project ids."}
            )
        if not isinstance(value, dict) or set(value.keys()) - {"hidden_columns"}:
            raise ValidationError(
                {
                    "preferences.board_column_prefs": (
                        f"Value for project {project_id!r} must be an object "
                        "with only a `hidden_columns` key."
                    )
                }
            )
        hidden = value.get("hidden_columns", [])
        if not isinstance(hidden, list):
            raise ValidationError(
                {
                    "preferences.board_column_prefs": (
                        f"`hidden_columns` for project {project_id!r} must be a list."
                    )
                }
            )
        ids: list[int] = []
        for cid in hidden:
            if isinstance(cid, bool) or not isinstance(cid, int):
                raise ValidationError(
                    {
                        "preferences.board_column_prefs": (
                            f"`hidden_columns` for project {project_id!r} must "
                            "contain only integers."
                        )
                    }
                )
            ids.append(cid)
        validated[project_id] = {"hidden_columns": ids}
    return validated


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
        return Response(_me_payload(request.user, request))

    @extend_schema(
        request={
            "application/json": {
                "type": "object",
                "properties": {
                    "avatar_url": {"type": "string"},
                    "preferences": {
                        "type": "object",
                        "properties": {
                            "assign_hotkey_bindings": {
                                "type": "object",
                                "additionalProperties": {"type": "integer"},
                            },
                            "board_column_prefs": {
                                "type": "object",
                                "additionalProperties": {
                                    "type": "object",
                                    "properties": {
                                        "hidden_columns": {
                                            "type": "array",
                                            "items": {"type": "integer"},
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
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

        prefs = request.data.get("preferences")
        if isinstance(prefs, dict) and "assign_hotkey_bindings" in prefs:
            raw = prefs.get("assign_hotkey_bindings")
            if not isinstance(raw, dict):
                raise ValidationError(
                    {"preferences.assign_hotkey_bindings": "Must be an object."}
                )
            candidate_uids: set[int] = set()
            staged: dict[str, int] = {}
            for k, v in raw.items():
                if not isinstance(k, str):
                    continue
                # Strip anything that would collide with skip/close before it
                # ever lands in the DB.
                if k in _RESERVED_HOTKEYS:
                    continue
                try:
                    uid = int(v)
                except (TypeError, ValueError):
                    continue
                staged[k] = uid
                candidate_uids.add(uid)
            # Drop bindings that point at users which no longer exist.
            existing_ids = set(
                User.objects.filter(id__in=candidate_uids).values_list("id", flat=True)
            )
            profile.assign_hotkey_bindings = {
                k: uid for k, uid in staged.items() if uid in existing_ids
            }
            profile.save(update_fields=["assign_hotkey_bindings"])

        if isinstance(prefs, dict) and "board_column_prefs" in prefs:
            profile.board_column_prefs = _validate_board_column_prefs(
                prefs.get("board_column_prefs")
            )
            profile.save(update_fields=["board_column_prefs"])

        return Response(_me_payload(request.user, request))


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
    event_type = data.get("type")
    payload = data.get("payload") or {}
    scope = data.get("scope")

    if scope == "wiki":
        # Wiki tree broadcasts route into the dedicated global ``wiki`` group.
        from apps.wiki.broadcast import _broadcast_local as _wiki_local

        if not isinstance(event_type, str):
            return Response(
                {"detail": "Invalid payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        _wiki_local(event_type, payload)
        return Response({"ok": True})

    if scope == "group":
        # Generic per-group push (e.g. notifications' user_<id> groups) —
        # see apps.tasks.broadcast.broadcast_to_group.
        from .broadcast import _broadcast_group_local

        group_name = data.get("group")
        if not isinstance(group_name, str) or not isinstance(event_type, str):
            return Response(
                {"detail": "Invalid payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        _broadcast_group_local(group_name, event_type, payload)
        return Response({"ok": True})

    project_id = data.get("project_id")
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


class ThroughputView(APIView):
    """GET the daily throughput series (created/started/in_review/completed).

    Read-only aggregation over the state-transition log; delegates the math to
    :func:`apps.tasks.analytics.throughput`. Query params:

    * ``project`` — project id, omitted for all projects.
    * ``from`` / ``to`` — inclusive ``YYYY-MM-DD`` bounds. Defaults: ``to`` is
      today in ``tz``, ``from`` is ``to`` − 29 days (a 30-day window).
    * ``tz`` — IANA name used for day bucketing (default ``UTC``).
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from datetime import date, timedelta
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        from .analytics import MAX_RANGE_DAYS, throughput

        tz_name = request.query_params.get("tz") or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError, ModuleNotFoundError) as exc:
            raise ValidationError({"tz": f"Unknown timezone {tz_name!r}."}) from exc

        def _parse_date(raw: str, field: str) -> date:
            try:
                return date.fromisoformat(raw)
            except ValueError as exc:
                raise ValidationError(
                    {field: f"Expected a YYYY-MM-DD date, got {raw!r}."}
                ) from exc

        today = timezone.now().astimezone(tz).date()
        to_raw = request.query_params.get("to")
        date_to = _parse_date(to_raw, "to") if to_raw else today
        from_raw = request.query_params.get("from")
        date_from = (
            _parse_date(from_raw, "from") if from_raw else date_to - timedelta(days=29)
        )

        if date_from > date_to:
            raise ValidationError({"from": "'from' must not be after 'to'."})
        # Inclusive span; +1 so a same-day request counts as one day.
        if (date_to - date_from).days + 1 > MAX_RANGE_DAYS:
            raise ValidationError(
                {"range": f"Range must not exceed {MAX_RANGE_DAYS} days."}
            )

        project_id: int | None = None
        project_raw = request.query_params.get("project")
        if project_raw not in (None, ""):
            try:
                project_id = int(project_raw)
            except (TypeError, ValueError) as exc:
                raise ValidationError(
                    {"project": "Must be an integer project id."}
                ) from exc
            if not Project.objects.filter(pk=project_id).exists():
                raise ValidationError({"project": "Project not found."})

        return Response(
            {"days": throughput(project_id, date_from, date_to, tz)}
        )


class WeeklyCompletionsView(APIView):
    """GET weekly completion counts, overall and per person.

    Read-only aggregation over the state-transition log; delegates the math to
    :func:`apps.tasks.analytics.weekly_completions`. Query params:

    * ``project`` — project id, omitted for all projects.
    * ``week`` — any ``YYYY-MM-DD`` date inside the desired week (default:
      today in ``tz``). Weeks are Monday-start, computed in ``tz``.
    * ``weeks`` — trend length, default 8, silently capped at
      :data:`~apps.tasks.analytics.MAX_WEEKS`.
    * ``tz`` — IANA name used for week bucketing (default ``UTC``).
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from datetime import date
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        from .analytics import MAX_WEEKS, weekly_completions

        tz_name = request.query_params.get("tz") or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError, ModuleNotFoundError) as exc:
            raise ValidationError({"tz": f"Unknown timezone {tz_name!r}."}) from exc

        week_raw = request.query_params.get("week")
        if week_raw:
            try:
                week = date.fromisoformat(week_raw)
            except ValueError as exc:
                raise ValidationError(
                    {"week": f"Expected a YYYY-MM-DD date, got {week_raw!r}."}
                ) from exc
        else:
            week = timezone.now().astimezone(tz).date()

        weeks_raw = request.query_params.get("weeks")
        if weeks_raw not in (None, ""):
            try:
                weeks = int(weeks_raw)
            except (TypeError, ValueError) as exc:
                raise ValidationError({"weeks": "Must be an integer."}) from exc
            if weeks < 1:
                raise ValidationError({"weeks": "Must be at least 1."})
        else:
            weeks = 8
        weeks = min(weeks, MAX_WEEKS)

        project_id: int | None = None
        project_raw = request.query_params.get("project")
        if project_raw not in (None, ""):
            try:
                project_id = int(project_raw)
            except (TypeError, ValueError) as exc:
                raise ValidationError(
                    {"project": "Must be an integer project id."}
                ) from exc
            if not Project.objects.filter(pk=project_id).exists():
                raise ValidationError({"project": "Project not found."})

        return Response(
            weekly_completions(project_id, week, weeks, tz, request=request)
        )


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

    @action(detail=False, methods=["post"])
    def reorder(self, request):
        """Persist this user's personal sidebar project ordering.

        Body: ``{"order": [<project_id>, ...]}`` — the full desired order
        (favorites-in-order followed by active-non-starred-in-order). Each
        project's index becomes its ``sidebar_position``. Per-user only; no
        broadcast (purely personal state).
        """
        from .models import UserProfile

        raw = request.data.get("order")
        if not isinstance(raw, list):
            return Response(
                {"detail": "`order` must be a list of project ids."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        order: list[int] = []
        seen: set[int] = set()
        for value in raw:
            try:
                pid = int(value)
            except (TypeError, ValueError):
                return Response(
                    {"detail": "`order` must contain integer project ids."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if pid not in seen:
                seen.add(pid)
                order.append(pid)
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        profile.sidebar_project_order = order
        profile.save(update_fields=["sidebar_project_order"])
        return Response({"order": order})


class ColumnViewSet(viewsets.ModelViewSet):
    queryset = Column.objects.all().order_by("project_id", "order")
    serializer_class = ColumnSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project"]

    def perform_create(self, serializer):
        project = serializer.validated_data["project"]
        # Append to the end. The (project, order) unique constraint means we
        # need a value that doesn't collide with an existing column.
        with transaction.atomic():
            current_max = (
                project.columns.aggregate(m=Max("order"))["m"]
                if project.columns.exists()
                else None
            )
            next_order = 0 if current_max is None else current_max + 1
            column = serializer.save(order=next_order)
        broadcast_task_event(
            project.id, "column.created", {"column": ColumnSerializer(column).data}
        )

    def perform_update(self, serializer):
        instance: Column = serializer.instance
        new_project = serializer.validated_data.get("project")
        if new_project is not None and new_project.id != instance.project_id:
            raise ValidationError(
                {"project": "Cannot move a column between projects."}
            )
        new_kind = serializer.validated_data.get("kind", instance.kind)
        if instance.is_done and new_kind != "done":
            # Don't let the last done column get demoted — recurring task
            # defaults and analytics rely on at least one existing. ``is_done``
            # is derived from ``kind`` on save, so we gate on the incoming kind.
            others_done = (
                instance.project.columns.filter(is_done=True)
                .exclude(pk=instance.pk)
                .exists()
            )
            if not others_done:
                raise ValidationError(
                    {"kind": "At least one column must be marked as done."}
                )
        column = serializer.save()
        broadcast_task_event(
            column.project_id,
            "column.updated",
            {"column": ColumnSerializer(column).data},
        )

    def destroy(self, request, *args, **kwargs):
        column: Column = self.get_object()
        project = column.project
        move_to_id = request.query_params.get("move_tasks_to") or request.data.get(
            "move_tasks_to"
        )

        with transaction.atomic():
            has_tasks = column.tasks.exists()
            target: Column | None = None
            if move_to_id is not None:
                try:
                    target = project.columns.exclude(pk=column.pk).get(pk=move_to_id)
                except Column.DoesNotExist as exc:
                    raise ValidationError(
                        {"move_tasks_to": "Target column not found in this project."}
                    ) from exc
            if has_tasks and target is None:
                raise ValidationError(
                    {
                        "move_tasks_to": (
                            "Column has tasks. Pass move_tasks_to=<column_id> "
                            "to relocate them before deletion."
                        )
                    }
                )
            if column.is_done and not (
                project.columns.filter(is_done=True).exclude(pk=column.pk).exists()
            ):
                raise ValidationError(
                    "Cannot delete the last column marked as done. Mark "
                    "another column as done first."
                )
            if target is not None:
                # Append to the bottom of the target column. Reuse the
                # bottom-position helper used elsewhere so positions stay sane.
                next_pos = (
                    target.tasks.aggregate(m=Max("position"))["m"] or 0
                ) + 1000.0
                for task in column.tasks.order_by("position"):
                    task.column = target
                    task.position = next_pos
                    task.save(update_fields=["column", "position", "updated_at"])
                    record_transition(
                        task,
                        from_column=column,
                        to_column=target,
                        event_type=TransitionEvent.MOVED,
                        user=request.user,
                        source=TransitionSource.USER,
                    )
                    next_pos += 1000.0
                    broadcast_task_event(
                        project.id,
                        "task.moved",
                        {"task": TaskReadSerializer(task).data},
                    )
            column_id = column.id
            column.delete()

        broadcast_task_event(
            project.id, "column.deleted", {"column_id": column_id}
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["post"], url_path="reorder")
    def reorder(self, request):
        """Atomically reassign the ``order`` field for every column in a project.

        Body: ``{"project": <id>, "ordered_ids": [<column_id>, ...]}``. The
        ``ordered_ids`` list must contain every column belonging to the
        project exactly once.
        """
        project_id = request.data.get("project")
        ordered_ids = request.data.get("ordered_ids")
        if not project_id or not isinstance(ordered_ids, list):
            raise ValidationError(
                "Body must include 'project' and 'ordered_ids' (list)."
            )
        try:
            project = Project.objects.get(pk=project_id)
        except Project.DoesNotExist as exc:
            raise ValidationError({"project": "Project not found."}) from exc

        with transaction.atomic():
            existing = list(project.columns.select_for_update().order_by("order"))
            existing_ids = {c.id for c in existing}
            try:
                ordered_ids_int = [int(x) for x in ordered_ids]
            except (TypeError, ValueError) as exc:
                raise ValidationError(
                    {"ordered_ids": "Must be a list of column ids."}
                ) from exc
            if set(ordered_ids_int) != existing_ids or len(ordered_ids_int) != len(
                existing
            ):
                raise ValidationError(
                    {
                        "ordered_ids": (
                            "Must list every column in the project exactly once."
                        )
                    }
                )

            # Two-phase reassignment: shift everyone into a non-overlapping
            # range first so the (project, order) unique constraint can't
            # conflict mid-update, then assign final values.
            offset = (max(c.order for c in existing) if existing else 0) + 1000
            for c in existing:
                Column.objects.filter(pk=c.pk).update(order=c.order + offset)
            by_id = {c.id: c for c in existing}
            for new_index, cid in enumerate(ordered_ids_int):
                Column.objects.filter(pk=cid).update(order=new_index)
                by_id[cid].order = new_index

            refreshed = list(project.columns.order_by("order"))

        broadcast_task_event(
            project.id,
            "column.reordered",
            {"columns": ColumnSerializer(refreshed, many=True).data},
        )
        return Response(ColumnSerializer(refreshed, many=True).data)


class LabelViewSet(viewsets.ModelViewSet):
    queryset = Label.objects.all().order_by("project_id", "name")
    serializer_class = LabelSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project"]


# ---------------------------------------------------------------------------
# Bets (Cyt OS)
# ---------------------------------------------------------------------------
# Bet/Metric/Checkin writes broadcast a ``bet.*`` event into the project's
# Channels group so open bets pages (and bet chips on boards) refetch live —
# same mechanism as task events.


def _broadcast_bet_event(project_id: int | None, event_type: str, bet_id: int):
    if project_id is not None:
        broadcast_task_event(project_id, event_type, {"bet_id": bet_id})


class BetViewSet(viewsets.ModelViewSet):
    serializer_class = BetSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project", "status"]

    def get_queryset(self):
        qs = (
            Bet.objects.all()
            .select_related("project")
            .prefetch_related(
                "metrics__checkins__created_by__profile", "tasks__column"
            )
            .annotate(
                task_count=models.Count("tasks", distinct=True),
                done_task_count=models.Count(
                    "tasks",
                    filter=models.Q(tasks__column__is_done=True),
                    distinct=True,
                ),
            )
        )
        # ``period`` narrows to one period of the fixed two-month grid:
        # "current", or any ISO date (snapped to its containing period).
        period = self.request.query_params.get("period")
        if period == "current":
            qs = qs.filter(period_start=current_period_start())
        elif period:
            try:
                from datetime import date

                snapped = period_start_for(date.fromisoformat(period))
            except ValueError as exc:
                raise ValidationError(
                    {"period": 'Use "current" or an ISO date (YYYY-MM-DD).'}
                ) from exc
            qs = qs.filter(period_start=snapped)
        return qs

    def perform_create(self, serializer):
        bet = serializer.save()
        _broadcast_bet_event(bet.project_id, "bet.created", bet.id)

    def perform_update(self, serializer):
        instance: Bet = serializer.instance
        new_project = serializer.validated_data.get("project")
        if new_project is not None and new_project.id != instance.project_id:
            raise ValidationError(
                {"project": "Cannot move a bet between projects."}
            )
        bet = serializer.save()
        _broadcast_bet_event(bet.project_id, "bet.updated", bet.id)

    def perform_destroy(self, instance):
        project_id, bet_id = instance.project_id, instance.id
        instance.delete()  # Task.bet is SET_NULL — linked tasks survive
        _broadcast_bet_event(project_id, "bet.deleted", bet_id)


class MetricViewSet(viewsets.ModelViewSet):
    queryset = Metric.objects.all().select_related("bet")
    serializer_class = MetricSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["bet"]

    def perform_create(self, serializer):
        metric = serializer.save()
        _broadcast_bet_event(metric.bet.project_id, "bet.updated", metric.bet_id)

    def perform_update(self, serializer):
        instance: Metric = serializer.instance
        new_bet = serializer.validated_data.get("bet")
        if new_bet is not None and new_bet.id != instance.bet_id:
            raise ValidationError({"bet": "Cannot move a metric between bets."})
        metric = serializer.save()
        _broadcast_bet_event(metric.bet.project_id, "bet.updated", metric.bet_id)

    def perform_destroy(self, instance):
        project_id, bet_id = instance.bet.project_id, instance.bet_id
        instance.delete()
        _broadcast_bet_event(project_id, "bet.updated", bet_id)


class CheckinViewSet(viewsets.ModelViewSet):
    queryset = Checkin.objects.all().select_related(
        "metric__bet", "created_by__profile"
    )
    serializer_class = CheckinSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["metric"]

    def perform_create(self, serializer):
        checkin = serializer.save()
        bet = checkin.metric.bet
        _broadcast_bet_event(bet.project_id, "bet.updated", bet.id)

    def perform_update(self, serializer):
        instance: Checkin = serializer.instance
        new_metric = serializer.validated_data.get("metric")
        if new_metric is not None and new_metric.id != instance.metric_id:
            raise ValidationError(
                {"metric": "Cannot move a check-in between metrics."}
            )
        checkin = serializer.save()
        bet = checkin.metric.bet
        _broadcast_bet_event(bet.project_id, "bet.updated", bet.id)

    def perform_destroy(self, instance):
        bet = instance.metric.bet
        instance.delete()
        _broadcast_bet_event(bet.project_id, "bet.updated", bet.id)


# ---------------------------------------------------------------------------
# Tasks — the hot path
# ---------------------------------------------------------------------------


_SORT_DIRS = {"asc", "desc"}

# Scalar task fields whose change on an "update" write triggers an "updated"
# notification to still-assigned users (newly-added assignees get "assigned"
# instead — see TaskViewSet.perform_update). Column changes are intentionally
# excluded here: those go through the dedicated `move` action and emit
# "moved"/"completed" instead.
_NOTIFY_TRACKED_SCALAR_FIELDS = ("title", "description", "priority", "story_points", "due_at")


def _extract_ad_hoc_filters(params) -> dict:
    """Translate query-string params into the dict shape ``apply_task_filters``
    expects. Missing params yield an empty dict so callers can cheaply check
    whether ad-hoc filtering was requested at all.

    Accepts both singular (``column=7``) and list (``priority=P1&priority=P2``)
    forms. ``assignee`` follows the saved-view convention where the literal
    string ``none`` means "include unassigned" alongside any listed ids.
    """
    filters: dict = {}

    if project := params.get("project"):
        filters["project"] = project

    # ``column`` carries either an id ("7") or a name ("Backlog") — both
    # accepted downstream in ``apply_task_filters``.
    if column := params.get("column"):
        filters["column"] = column

    priorities = [p for p in params.getlist("priority") if p]
    if priorities:
        filters["priority"] = priorities

    assignees = [a for a in params.getlist("assignee") if a]
    if assignees:
        filters["assignee"] = assignees

    labels = [l for l in params.getlist("label") if l]
    if labels:
        filters["labels"] = labels

    # ``bet`` carries an id, a name, or the sentinel "none" (unlinked tasks).
    if bet := params.get("bet"):
        filters["bet"] = bet

    # ``done`` — "true"/"1"/"yes" keeps only tasks in an is_done column,
    # anything else keeps open tasks.
    if (done := params.get("done")) not in (None, ""):
        filters["done"] = done

    if search := params.get("search"):
        filters["search"] = search

    # ``include_archived`` is a board toggle: absent means "no opinion" (leave
    # archived-project tasks in), an explicit truthy/falsy value opts into
    # including/excluding them on the all-projects board.
    raw_archived = params.get("include_archived")
    if raw_archived is not None:
        filters["include_archived"] = raw_archived.lower() not in (
            "false",
            "0",
            "no",
            "",
        )

    return filters


def _extract_ad_hoc_sort(params) -> list | None:
    """Turn ``sort_field`` / ``sort_dir`` query params into the sort-spec
    list ``apply_task_sort`` expects. Returns ``None`` when no sort is
    requested so the caller can distinguish "no preference" from "explicit".
    """
    field = params.get("sort_field")
    if not field:
        return None
    direction = (params.get("sort_dir") or "asc").lower()
    if direction not in _SORT_DIRS:
        direction = "asc"
    return [{"field": field, "dir": direction}]


class TaskViewSet(viewsets.ModelViewSet):
    """All task CRUD. Lookup is by the human key (``CYT-001``).

    Filtering and sorting accept the same shape that saved ``View``s store on
    disk, passed as query-string params. The frontend board/list pages send
    these directly so pagination can work server-side; ``?view=<id>`` remains
    as a fallback for direct API/MCP callers that want to load a saved view
    by id without enumerating its filter keys.
    """

    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"

    def get_queryset(self):
        qs = base_task_queryset()
        params = self.request.query_params

        ad_hoc_filters = _extract_ad_hoc_filters(params)
        ad_hoc_sort = _extract_ad_hoc_sort(params)

        if ad_hoc_filters or ad_hoc_sort:
            return filter_and_sort_tasks(
                ad_hoc_filters,
                ad_hoc_sort,
                requesting_user=self.request.user,
                base=qs,
            )

        view_id = params.get("view")
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
        record_transition(
            task,
            from_column=None,
            to_column=task.column,
            event_type=TransitionEvent.CREATED,
            user=self.request.user,
            source=TransitionSource.USER,
        )
        broadcast_task_event(
            task.project_id, "task.created", {"key": task.key, "id": task.id}
        )
        # Recipients default to task.assignees.all() minus the acting user.
        notify_task_event(task, self.request.user, "assigned")
        # "created" is webhook-only (recipients=[]) — see WEBHOOK_EVENT_TYPES
        # / notify_task_event's guard. Fires alongside "assigned" above when
        # the task is created with assignees — intentional, GitHub-style
        # distinct events, not deduped.
        notify_task_event(task, self.request.user, "created", recipients=[])

    def perform_update(self, serializer):
        # Capture old column + assignees + tracked scalar fields before the
        # update so we can record the transition and diff for notifications.
        instance = serializer.instance
        old_column = instance.column if instance else None
        old_assignee_ids = (
            set(instance.assignees.values_list("id", flat=True)) if instance else set()
        )
        old_label_ids = (
            set(instance.labels.values_list("id", flat=True)) if instance else set()
        )
        old_values = (
            {f: getattr(instance, f) for f in _NOTIFY_TRACKED_SCALAR_FIELDS}
            if instance
            else {}
        )

        task = serializer.save()
        if task.column_id != (old_column.id if old_column else None):
            record_transition(
                task,
                from_column=old_column,
                to_column=task.column,
                event_type=TransitionEvent.MOVED,
                user=self.request.user,
                source=TransitionSource.USER,
            )
        broadcast_task_event(
            task.project_id, "task.updated", {"key": task.key, "id": task.id}
        )

        actor = self.request.user
        new_assignee_ids = set(task.assignees.values_list("id", flat=True))
        newly_added_ids = new_assignee_ids - old_assignee_ids
        still_assigned_ids = new_assignee_ids & old_assignee_ids

        if newly_added_ids:
            notify_task_event(
                task,
                actor,
                "assigned",
                recipients=User.objects.filter(id__in=newly_added_ids),
            )

        changed_fields = [
            f for f in _NOTIFY_TRACKED_SCALAR_FIELDS if old_values.get(f) != getattr(task, f)
        ]
        new_label_ids = set(task.labels.values_list("id", flat=True))
        if new_label_ids != old_label_ids:
            changed_fields.append("labels")

        if changed_fields:
            notify_task_event(
                task,
                actor,
                "updated",
                recipients=User.objects.filter(id__in=still_assigned_ids),
                payload={"changed_fields": changed_fields},
            )

    def perform_destroy(self, instance):
        project_id = instance.project_id
        key = instance.key
        # Notify before deleting — Notification.task is SET_NULL, so the row
        # survives the cascade; task_key/task_title are already denormalized.
        notify_task_event(instance, self.request.user, "deleted")
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
                    event_type=TransitionEvent.MOVED,
                    user=request.user,
                    source=TransitionSource.USER,
                )

        broadcast_task_event(
            task.project_id,
            "task.moved",
            {"key": task.key, "id": task.id, "column_id": column.id},
        )
        if (old_column.id if old_column else None) != column.id:
            verb = "completed" if column.is_done else "moved"
            notify_task_event(
                task,
                request.user,
                verb,
                payload={
                    "from_column": old_column.name if old_column else None,
                    "to_column": column.name,
                },
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

    ``after_id``/``before_id`` are resolved *globally*, not restricted to
    ``column``'s tasks. That lets the all-projects virtual kanban hand us
    neighbour ids from any project — the resulting numeric position is
    consistent with the cross-project visual slot the user dropped into.
    The moved task still ends up in ``column``; only the *numeric* position
    comes from the global neighbours.
    """
    # Lazy rebalance: every task created before the position-on-create fix
    # shares the model default (1000.0). Midpoint math on a tied column
    # returns that same value, so the move silently no-ops and the client
    # snaps back to (position, id) order. Spread the column out once on the
    # first move it sees; subsequent moves get clean unique midpoints.
    _rebalance_if_tied(column, exclude_task_id=task_id)

    after = (
        Task.objects.filter(id=after_id).exclude(id=task_id).first()
        if after_id
        else None
    )
    before = (
        Task.objects.filter(id=before_id).exclude(id=task_id).first()
        if before_id
        else None
    )

    if after and before:
        return (after.position + before.position) / 2.0
    # For the one-sided cases, search among tasks in same-named columns
    # (e.g. every project's "Todo") — that matches what the all-projects
    # virtual kanban displays as one logical column and keeps single-
    # project kanban correct too (only one such column exists there).
    if after and not before:
        bigger = (
            Task.objects.filter(
                position__gt=after.position,
                column__name__iexact=column.name,
            )
            .exclude(id=task_id)
            .order_by("position", "id")
            .values_list("position", flat=True)
            .first()
        )
        if bigger is None:
            return after.position + 1000.0
        return (after.position + bigger) / 2.0
    if before and not after:
        smaller = (
            Task.objects.filter(
                position__lt=before.position,
                column__name__iexact=column.name,
            )
            .exclude(id=task_id)
            .order_by("-position", "-id")
            .values_list("position", flat=True)
            .first()
        )
        if smaller is None:
            return before.position - 1000.0
        return (smaller + before.position) / 2.0
    # Append to bottom of the target column.
    tail = column.tasks.exclude(id=task_id).aggregate(m=Max("position"))["m"]
    return (tail or 0) + 1000.0


def _rebalance_if_tied(column: Column, *, exclude_task_id: int) -> None:
    """Re-space positions in a column if any ties exist.

    Preserves the current (position, id) ordering — the user-visible layout
    doesn't change, midpoint math just gains room to bisect. One bulk UPDATE.
    """
    neighbors = column.tasks.exclude(id=exclude_task_id)
    positions = list(neighbors.values_list("position", flat=True))
    if len(positions) == len(set(positions)):
        return
    ordered = list(neighbors.order_by("position", "id"))
    for i, t in enumerate(ordered, start=1):
        t.position = i * 1000.0
    Task.objects.bulk_update(ordered, ["position"])


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
        .select_related("project", "column", "created_by")
        .prefetch_related("labels", "assignees")
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


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    """Current user's notifications. Strictly scoped to ``request.user`` —
    both ``get_queryset`` (list/retrieve/the ``read`` action's ``get_object``)
    and the bulk actions below only ever touch the caller's own rows."""

    serializer_class = NotificationSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Notification.objects.none()
        qs = self.request.user.notifications.select_related("actor", "project")
        unread = self.request.query_params.get("unread")
        if unread in ("1", "true", "True"):
            qs = qs.filter(read_at__isnull=True)
        return qs

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True)
            data = self.get_paginated_response(serializer.data).data
        else:
            serializer = self.get_serializer(queryset, many=True)
            data = {"results": serializer.data}
        data["unread_count"] = request.user.notifications.filter(
            read_at__isnull=True
        ).count()
        return Response(data)

    @action(detail=True, methods=["post"])
    def read(self, request, pk=None):
        """Mark a single notification read. 404s for another user's rows
        because ``get_object`` resolves against ``get_queryset`` above."""
        notification = self.get_object()
        if notification.read_at is None:
            notification.read_at = timezone.now()
            notification.save(update_fields=["read_at"])
        return Response(NotificationSerializer(notification).data)

    @action(detail=False, methods=["post"], url_path="read_all")
    def read_all(self, request):
        updated = request.user.notifications.filter(read_at__isnull=True).update(
            read_at=timezone.now()
        )
        return Response({"updated": updated})

    @action(detail=False, methods=["get"], url_path="unread_count")
    def unread_count(self, request):
        count = request.user.notifications.filter(read_at__isnull=True).count()
        return Response({"unread_count": count})
