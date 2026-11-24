"""Settings → Access: staff edit each user's modules and projects.

Not listed in ``API_MODULES``, so ``ModuleAccessMiddleware`` already refuses
non-staff; the permission class below is the second line.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.views import APIView

from .access import MODULES, has_full_access
from .models import Project, UserProfile

User = get_user_model()


class FullAccessOnly(BasePermission):
    def has_permission(self, request, view):
        return has_full_access(request.user)


def _user_row(user) -> dict:
    profile = getattr(user, "profile", None)
    return {
        "id": user.pk,
        "username": user.username,
        "name": f"{user.first_name} {user.last_name}".strip(),
        "is_staff": has_full_access(user),
        "modules": [m for m in MODULES if m in ((profile.modules if profile else None) or [])],
        "project_ids": sorted(p.pk for p in user.member_projects.all()),
    }


def _users():
    return (
        User.objects.filter(is_active=True)
        .select_related("profile")
        .prefetch_related("member_projects")
        .order_by("username")
    )


def _id_list(raw, field: str) -> list:
    if not isinstance(raw, list):
        raise ValidationError({field: "Must be a list."})
    return raw


class AccessMatrixView(APIView):
    """``GET /api/access/`` — every module, project and active user."""

    permission_classes = [FullAccessOnly]

    def get(self, request):
        return Response(
            {
                "modules": list(MODULES),
                "projects": list(
                    Project.objects.order_by("name").values("id", "prefix", "name")
                ),
                "users": [_user_row(u) for u in _users()],
            }
        )


class AccessUserView(APIView):
    """``PATCH /api/access/users/<id>/ {modules?, project_ids?}`` — each list
    replaces the user's current one."""

    permission_classes = [FullAccessOnly]

    def patch(self, request, pk: int):
        user = get_object_or_404(User, pk=pk, is_active=True)
        if has_full_access(user):
            # Staff bypass both lists; editing them would only mislead.
            raise ValidationError({"detail": "Staff already have full access."})
        modules = request.data.get("modules")
        project_ids = request.data.get("project_ids")
        if modules is not None:
            modules = _id_list(modules, "modules")
            unknown = sorted({str(m) for m in modules} - set(MODULES))
            if unknown:
                raise ValidationError({"modules": f"Unknown module(s): {', '.join(unknown)}."})
        if project_ids is not None:
            project_ids = _id_list(project_ids, "project_ids")
            if not all(isinstance(p, int) and not isinstance(p, bool) for p in project_ids):
                raise ValidationError({"project_ids": "Must be a list of project ids."})
            projects = list(Project.objects.filter(pk__in=project_ids))
            if len(projects) != len(set(project_ids)):
                raise ValidationError({"project_ids": "Unknown project id."})
        with transaction.atomic():
            if modules is not None:
                profile, _ = UserProfile.objects.get_or_create(user=user)
                profile.modules = [m for m in MODULES if m in modules]
                profile.save(update_fields=["modules"])
            if project_ids is not None:
                user.member_projects.set(projects)
        return Response(_user_row(_users().get(pk=user.pk)))
