"""Who can see what.

Staff see everything. A non-staff user never sees tasks, and in meetings and
the wiki sees only what belongs to a project they are a member of
(``Project.members``, edited in the Django admin), plus wiki pages they created
and Drive files they uploaded or were shared. Anything without a project is
staff-only — new content is hidden until someone files it.

Every REST read path for meetings, wiki, Drive and the LLM wiki goes through
these helpers. Task endpoints keep their project filters too, as a second
line behind the middleware. Non-staff are kept out of every other app by
``NonStaffAccessMiddleware`` and out of MCP by ``_ScopedFastMCP.call_tool``.
"""

from __future__ import annotations

from django.db.models import QuerySet
from django.http import JsonResponse
from rest_framework.permissions import BasePermission

SAFE = frozenset({"GET", "HEAD", "OPTIONS"})

#: The only API prefixes a non-staff user may call, and with which methods
#: (``None`` = any). Everything else — tasks, bets, routines, services, PR
#: reviews, CRM, monitoring, analytics, webhooks, MCP token management — is
#: refused, so an endpoint added later is staff-only until listed here.
NON_STAFF_API: tuple[tuple[str, frozenset[str] | None], ...] = (
    ("/api/auth/", None),
    ("/api/projects/", SAFE),  # names for the meetings filter; no tasks
    ("/api/users/", SAFE),
    ("/api/notifications/", None),
    ("/api/uploads/", None),
    ("/api/wiki-docs/", None),
    ("/api/drive/", None),
    ("/api/knowledge/", SAFE),
    ("/api/meetings/", None),  # writes: MeetingViewSet.staff_only_actions
    ("/api/meeting-entities/", SAFE),
)


class NonStaffAccessMiddleware:
    """Refuse every ``/api/`` route outside ``NON_STAFF_API`` for non-staff.

    Anonymous requests pass through untouched: DRF rejects them itself, and
    the secret-gated ``/api/internal/`` bridges carry no session at all.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        path = request.path
        if (
            path.startswith("/api/")
            and user is not None
            and user.is_authenticated
            and not has_full_access(user)
            and not any(
                path.startswith(prefix) and (methods is None or request.method in methods)
                for prefix, methods in NON_STAFF_API
            )
        ):
            return JsonResponse({"detail": "You don't have access to this."}, status=403)
        return self.get_response(request)


class StaffOnlyActions(BasePermission):
    """Restrict the view's ``staff_only_actions`` to staff."""

    def has_permission(self, request, view):
        return view.action not in getattr(view, "staff_only_actions", ()) or has_full_access(
            request.user
        )


def has_full_access(user) -> bool:
    return bool(user is not None and (user.is_staff or user.is_superuser))


def visible_project_ids(user) -> set[int] | None:
    """``None`` means unrestricted."""
    if has_full_access(user):
        return None
    if user is None or not user.is_authenticated:
        return set()
    return set(user.member_projects.values_list("pk", flat=True))


def can_see_project(user, project_id: int | None) -> bool:
    ids = visible_project_ids(user)
    return ids is None or project_id in ids


def restrict_to_projects(qs: QuerySet, user, field: str = "project") -> QuerySet:
    ids = visible_project_ids(user)
    if ids is None:
        return qs
    return qs.filter(**{f"{field}_id__in": ids})


def visible_doc_ids(user) -> set[int] | None:
    """Wiki pages a non-staff user can see (``None`` = all).

    A page without its own project inherits the nearest ancestor's, so filing
    a top-level page under a project covers its whole subtree. Pages the user
    created stay visible to them, so a page they make doesn't vanish before
    it's filed.

    ponytail: loads every page's (id, parent, project, author) per call — fine
    for thousands of pages; move to a recursive CTE if the wiki outgrows that.
    """
    from apps.wiki.models import Doc

    projects = visible_project_ids(user)
    if projects is None:
        return None
    rows = list(Doc.objects.values_list("pk", "parent_id", "project_id", "created_by_id"))
    parent_of = {pk: parent for pk, parent, _, _ in rows}
    project_of = {pk: project for pk, _, project, _ in rows}

    memo: dict[int, int | None] = {}

    def resolve(pk: int, seen: frozenset[int] = frozenset()) -> int | None:
        if pk not in memo:
            project, parent = project_of.get(pk), parent_of.get(pk)
            if project is None and parent is not None and parent not in seen:
                project = resolve(parent, seen | {pk})
            memo[pk] = project
        return memo[pk]

    return {
        pk
        for pk, _, _, author in rows
        if resolve(pk) in projects or (author is not None and author == user.pk)
    }


def visible_drive_keys(user) -> set[str] | None:
    """Drive keys a non-staff user can reach (``None`` = all)."""
    from django.db.models import Q

    from apps.drive.models import DriveFile

    if has_full_access(user):
        return None
    if user is None or not user.is_authenticated:
        return set()
    return set(
        DriveFile.objects.filter(Q(uploaded_by=user) | Q(shared_with=user))
        .values_list("key", flat=True)
        .distinct()
    )


def visible_knowledge_slugs(user) -> set[str] | None:
    """LLM-wiki slugs a non-staff user can read (``None`` = all): every
    project the page is filed under must be one of theirs."""
    from collections import defaultdict

    from apps.drive.models import KnowledgePageProject

    projects = visible_project_ids(user)
    if projects is None:
        return None
    filed: dict[str, set[int]] = defaultdict(set)
    for slug, project_id in KnowledgePageProject.objects.values_list("slug", "project_id"):
        filed[slug].add(project_id)
    return {slug for slug, ids in filed.items() if ids <= projects}


def scope_for_caller(qs: QuerySet, user, field: str = "project") -> QuerySet:
    """``restrict_to_projects`` for MCP, where ``user=None`` is a user-less
    operator credential (legacy token, stdio) and stays unrestricted."""
    return qs if user is None else restrict_to_projects(qs, user, field)
