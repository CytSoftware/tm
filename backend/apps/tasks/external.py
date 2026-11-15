"""``POST /api/external/tasks/`` — create a task from another system.

Built for Mowafeq's in-app feedback, which authenticates with a bot user's
personal access token. Creation goes through the MCP ``create_task`` helper so
the transition log, broadcast, notifications and webhooks stay identical to
every other write path; this view only validates, creates missing labels and
turns resolver errors into a 400 instead of a 500.

Scoping is the caller's: ``create_task`` resolves the project through the
caller's visible projects, so a non-staff account can only create in projects
it is a member of (anything else reads as an unknown project).
"""

from __future__ import annotations

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.models import Q
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.mcp_server import tools
from apps.mcp_server.rest_auth import PatAuthentication

from .models import Label


class ExternalTaskSerializer(serializers.Serializer):
    project = serializers.CharField(max_length=64)
    title = serializers.CharField(max_length=300)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    column = serializers.CharField(required=False, allow_null=True, default=None)
    labels = serializers.ListField(
        child=serializers.CharField(max_length=64), required=False, default=list
    )
    assignees = serializers.ListField(
        child=serializers.CharField(max_length=150), required=False, default=list
    )
    priority = serializers.CharField(required=False, allow_null=True, default=None)


class ExternalTaskCreatedSerializer(serializers.Serializer):
    key = serializers.CharField()
    id = serializers.IntegerField()
    url = serializers.CharField()


class _BadRequest(Exception):
    pass


def _flatten_errors(errors, prefix: str = "") -> list[str]:
    if isinstance(errors, dict):
        out = []
        for field, value in errors.items():
            label = prefix if field == "non_field_errors" else f"{prefix}{field}: "
            out += _flatten_errors(value, label)
        return out
    if isinstance(errors, list):
        out = []
        for value in errors:
            out += _flatten_errors(value, prefix)
        return out
    return [f"{prefix}{errors}"]


def _ensure_labels(project, names: list[str]) -> None:
    """Create the labels that match neither a project nor a global label.

    Matching is case-insensitive, like ``_resolve_labels``, so ``bug`` reuses an
    existing ``Bug`` instead of minting a near-duplicate.
    """
    candidates = Label.objects.filter(Q(project=project) | Q(project__isnull=True))
    for name in names:
        if not candidates.filter(name__iexact=name.strip()).exists():
            tools.create_label(name=name, project=project.pk)


class ExternalTaskView(APIView):
    authentication_classes = [PatAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["external"],
        summary="Create a task from an external system",
        request=ExternalTaskSerializer,
        responses={
            201: ExternalTaskCreatedSerializer,
            400: OpenApiResponse(description="Unknown project, column, assignee or priority"),
            401: OpenApiResponse(description="Missing, invalid, revoked or read-only token"),
        },
    )
    def post(self, request):
        ser = ExternalTaskSerializer(data=request.data)
        if not ser.is_valid():
            return Response(
                {"detail": " ".join(_flatten_errors(ser.errors))},
                status=status.HTTP_400_BAD_REQUEST,
            )
        data = ser.validated_data
        user = request.user

        try:
            with transaction.atomic():
                # Resolve each reference up front only to name the bad one in
                # the error; create_task resolves them again itself.
                try:
                    project = tools._resolve_project(data["project"], user)
                except (ObjectDoesNotExist, ValueError):
                    raise _BadRequest(f"Unknown project {data['project']!r}.")
                if data["column"]:
                    try:
                        tools._resolve_column(project, data["column"])
                    except (ObjectDoesNotExist, ValueError):
                        raise _BadRequest(
                            f"Unknown column {data['column']!r} in project {project.prefix}."
                        )
                for ref in data["assignees"]:
                    try:
                        tools._resolve_user(ref)
                    except (ObjectDoesNotExist, ValueError):
                        raise _BadRequest(f"Unknown assignee {ref!r}.")
                try:
                    tools._normalize_priority(data["priority"])
                except ValueError as exc:
                    raise _BadRequest(str(exc))

                labels = [name.strip() for name in data["labels"] if name.strip()]
                _ensure_labels(project, labels)
                task = tools.create_task(
                    project=project.pk,
                    title=data["title"],
                    description=data["description"],
                    assignees=data["assignees"] or None,
                    priority=data["priority"],
                    labels=labels or None,
                    column=data["column"] or None,
                    mcp_user=user,
                )
        except _BadRequest as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (ObjectDoesNotExist, ValueError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "key": task["key"],
                "id": task["id"],
                "url": f"{settings.FRONTEND_URL}/board?task={task['key']}",
            },
            status=status.HTTP_201_CREATED,
        )
