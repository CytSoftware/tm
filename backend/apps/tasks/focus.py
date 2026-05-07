"""Personal focus-list endpoints — `/api/me/focus/`.

Each user maintains a private list of tasks they want to focus on, split into
two buckets: ``day`` (today) and ``week`` (this week). The state is *per-user*
and orthogonal to assignment — focusing a task you don't own doesn't change
its assignees, and unfocusing it doesn't unassign you.

Why a dedicated endpoint instead of an ``is_focused`` flag on every Task:

* Task list payloads stay lean. The board, command palette, and table view all
  hammer ``/api/tasks/``; tacking on per-user state would make every read
  user-specific and break shared cache lines.
* The frontend loads the focus list once and stores a ``Set<task_id>`` keyed
  off the current user. Star buttons on cards read from the Set, not from the
  task object.
* Toggling focus invalidates only the focus query, not every ``tasks-infinite``
  cache.
"""

from __future__ import annotations

from django.db import transaction
from django.db.models import Max
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, serializers, status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import FocusItem, FocusPeriod, Task
from .serializers import TaskReadSerializer
from .transitions import get_stale_thresholds


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


class FocusItemSerializer(serializers.ModelSerializer):
    """Read-shape: embed the full task so the frontend can render cards
    without a second round-trip per item."""

    task = TaskReadSerializer(read_only=True)

    class Meta:
        model = FocusItem
        fields = ("id", "task", "period", "position", "created_at", "updated_at")
        read_only_fields = fields


class FocusItemAddSerializer(serializers.Serializer):
    """Write-shape for POST. ``task_key`` accepts the human key (CYT-001)
    rather than an internal id so MCP and curl callers can use the same
    identifier the frontend already exposes everywhere."""

    task_key = serializers.CharField(max_length=32)
    period = serializers.ChoiceField(
        choices=FocusPeriod.choices,
        default=FocusPeriod.WEEK,
        required=False,
    )


class FocusItemUpdateSerializer(serializers.Serializer):
    period = serializers.ChoiceField(
        choices=FocusPeriod.choices, required=False
    )
    position = serializers.FloatField(required=False)
    before_id = serializers.IntegerField(required=False, allow_null=True)
    after_id = serializers.IntegerField(required=False, allow_null=True)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def _serialize_items(qs, request):
    ctx = {
        "request": request,
        "staleness_thresholds": get_stale_thresholds(),
    }
    return FocusItemSerializer(qs, many=True, context=ctx).data


def _items_qs(user):
    """Base queryset: this user's focus items, with the embedded Task fully
    prefetched so the serializer doesn't N+1 on labels/assignees/columns."""
    return (
        FocusItem.objects.filter(user=user)
        .select_related(
            "task",
            "task__column",
            "task__project",
            "task__reporter",
        )
        .prefetch_related("task__assignees", "task__labels")
    )


def _bottom_position(user, period: str) -> float:
    tail = (
        FocusItem.objects.filter(user=user, period=period)
        .aggregate(m=Max("position"))["m"]
    )
    return (tail or 0.0) + 1000.0


def _compute_position(
    *,
    user,
    period: str,
    before_id: int | None,
    after_id: int | None,
    self_id: int | None,
) -> float:
    """Mirror of ``views._compute_position`` for focus reordering — midpoint
    insertion with ``before_id``/``after_id`` neighbours scoped to the same
    (user, period). When no neighbours are given, append to the bottom."""
    qs = FocusItem.objects.filter(user=user, period=period)
    if self_id is not None:
        qs = qs.exclude(id=self_id)

    after = qs.filter(id=after_id).first() if after_id else None
    before = qs.filter(id=before_id).first() if before_id else None

    if after and before:
        return (after.position + before.position) / 2.0
    if after:
        bigger = (
            qs.filter(position__gt=after.position)
            .order_by("position", "id")
            .values_list("position", flat=True)
            .first()
        )
        if bigger is None:
            return after.position + 1000.0
        return (after.position + bigger) / 2.0
    if before:
        smaller = (
            qs.filter(position__lt=before.position)
            .order_by("-position", "-id")
            .values_list("position", flat=True)
            .first()
        )
        if smaller is None:
            return before.position - 1000.0
        return (smaller + before.position) / 2.0
    return _bottom_position(user, period)


class FocusListView(APIView):
    """GET — list every focus item for the current user, ordered for display.

    POST — pin a task by its human key. Idempotent: if the user already has
    the task in focus, the existing pin is returned and its period updated if
    a new one was passed (so the same call does double duty as "promote to
    Today")."""

    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(responses=FocusItemSerializer(many=True))
    def get(self, request):
        qs = _items_qs(request.user).order_by("period", "position", "id")
        return Response(_serialize_items(qs, request))

    @extend_schema(
        request=FocusItemAddSerializer, responses=FocusItemSerializer
    )
    def post(self, request):
        payload = FocusItemAddSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        task = get_object_or_404(Task, key=payload.validated_data["task_key"])
        period = payload.validated_data.get("period") or FocusPeriod.WEEK

        with transaction.atomic():
            item, created = FocusItem.objects.select_for_update().get_or_create(
                user=request.user,
                task=task,
                defaults={
                    "period": period,
                    "position": _bottom_position(request.user, period),
                },
            )
            if not created and item.period != period:
                # Existing pin, but the caller wants it in a different
                # bucket — move it to the bottom of the requested bucket.
                item.period = period
                item.position = _bottom_position(request.user, period)
                item.save(update_fields=["period", "position", "updated_at"])

        qs = _items_qs(request.user).filter(pk=item.pk)
        return Response(
            _serialize_items(qs, request)[0],
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class FocusItemView(APIView):
    """PATCH — change period/position for a single pin (used for drag-and-
    drop between buckets and reorder within a bucket).

    DELETE — remove the pin."""

    permission_classes = [permissions.IsAuthenticated]
    lookup_field = "task_key"

    def _get_item(self, request, task_key: str) -> FocusItem:
        return get_object_or_404(
            FocusItem.objects.select_related("task"),
            user=request.user,
            task__key=task_key,
        )

    @extend_schema(
        request=FocusItemUpdateSerializer, responses=FocusItemSerializer
    )
    def patch(self, request, task_key: str):
        item = self._get_item(request, task_key)
        payload = FocusItemUpdateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data

        new_period = data.get("period", item.period)
        period_changed = new_period != item.period

        with transaction.atomic():
            if "position" in data:
                position = float(data["position"])
            else:
                position = _compute_position(
                    user=request.user,
                    period=new_period,
                    before_id=data.get("before_id"),
                    after_id=data.get("after_id"),
                    self_id=item.id,
                )
            item.period = new_period
            item.position = position
            item.save(update_fields=["period", "position", "updated_at"])

        # `period_changed` is unused right now but reserved — future work may
        # want to log a transition or fire a notification when an item gets
        # promoted into Today.
        del period_changed
        qs = _items_qs(request.user).filter(pk=item.pk)
        return Response(_serialize_items(qs, request)[0])

    @extend_schema(responses={204: None})
    def delete(self, request, task_key: str):
        item = self._get_item(request, task_key)
        item.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Helpers reused by MCP tools
# ---------------------------------------------------------------------------


def add_focus(*, user, task_key: str, period: str = FocusPeriod.WEEK) -> FocusItem:
    """Idempotent: returns the (possibly updated) FocusItem.

    Mirrors ``FocusListView.post`` so MCP and DRF share one code path."""
    if period not in dict(FocusPeriod.choices):
        raise ValidationError({"period": f"Invalid period: {period!r}"})
    task = get_object_or_404(Task, key=task_key)
    with transaction.atomic():
        item, created = FocusItem.objects.select_for_update().get_or_create(
            user=user,
            task=task,
            defaults={
                "period": period,
                "position": _bottom_position(user, period),
            },
        )
        if not created and item.period != period:
            item.period = period
            item.position = _bottom_position(user, period)
            item.save(update_fields=["period", "position", "updated_at"])
    return item


def remove_focus(*, user, task_key: str) -> bool:
    """Returns True if a pin was removed, False if it didn't exist."""
    deleted, _ = FocusItem.objects.filter(
        user=user, task__key=task_key
    ).delete()
    return deleted > 0
