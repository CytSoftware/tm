"""Who can see what: modules × projects.

A non-staff user has two independent lists, both edited by staff on Settings →
Access (``apps.tasks.access_views``): **modules** (``UserProfile.modules``) and
**projects** (``Project.members``). They see a row only when they hold the
module and — for a project-scoped module — the row's project is one of theirs.
Rows with no project stay staff-only, so new content is hidden until someone
files it. Staff and superusers (``has_full_access``) bypass everything.

``bets``, ``analytics`` and ``operations`` are module-only: holders see every
project's data. ``wiki``, ``llm_wiki`` and ``drive`` are a module gate in front
of their own rules (``visible_doc_ids``, ``visible_knowledge_slugs``,
``can_reach_drive``).

Every helper that scopes by project takes ``module`` as a **required**
argument, so a new call site has to say which module it serves. REST prefixes
are gated by ``ModuleAccessMiddleware`` (``API_MODULES``) and MCP tools by
``_ScopedFastMCP.call_tool`` (``TOOL_MODULES``); the helpers here are the
second line behind both.
"""

from __future__ import annotations

from django.db.models import QuerySet
from django.http import JsonResponse
from rest_framework.permissions import BasePermission

SAFE = frozenset({"GET", "HEAD", "OPTIONS"})

MODULES: tuple[str, ...] = (
    "tasks",
    "bets",
    "analytics",
    "crm",
    "billing",
    "meetings",
    "reports",
    "wiki",
    "llm_wiki",
    "drive",
    "operations",
)

#: Rows in these modules show only for the user's projects.
PROJECT_SCOPED = frozenset({"tasks", "crm", "billing", "meetings", "reports"})

#: Holding the module shows every project's rows.
MODULE_ONLY = frozenset({"bets", "analytics", "operations"})

#: ``(prefix, module, methods)``. ``module`` is a key, a tuple of keys (any one
#: will do) or ``None`` for "any signed-in user"; ``methods`` ``None`` = any.
#: Matched longest prefix first, so ``/api/crm/payments/`` needs ``billing``
#: even though ``/api/crm/`` routes need ``crm``. An unlisted prefix is refused
#: — an endpoint added later is staff-only until listed here.
API_MODULES: tuple[tuple[str, str | tuple[str, ...] | None, frozenset[str] | None], ...] = (
    ("/api/auth/", None, None),
    ("/api/users/", None, SAFE),
    ("/api/projects/", None, SAFE),  # scoped to membership by ProjectViewSet
    ("/api/notifications/", None, None),
    ("/api/uploads/", None, None),
    # Create-only, answers just the new key, and resolves the project through
    # the caller's memberships. Lets the Mowafeq feedback bot be a plain
    # member of MOW instead of staff. Not module-gated: it predates modules
    # and the bot only ever files feedback.
    ("/api/external/tasks/", None, frozenset({"POST"})),
    # tasks
    ("/api/tasks/", "tasks", None),
    ("/api/columns/", "tasks", SAFE),  # column writes are staff-only
    ("/api/labels/", "tasks", None),
    ("/api/views/", "tasks", None),
    ("/api/recurring-tasks/", "tasks", None),
    ("/api/me/focus/", "tasks", None),
    ("/api/settings/staleness/", "tasks", SAFE),  # the board's stale badges
    ("/api/integrations/github/pull-requests/", "tasks", SAFE),
    # bets / analytics
    ("/api/bets/", "bets", None),
    ("/api/metrics/", "bets", None),
    ("/api/checkins/", "bets", None),
    ("/api/analytics/", "analytics", SAFE),
    # CRM. Billing needs the company picker and the scope switcher too.
    ("/api/crm/leads/", "crm", None),
    ("/api/crm/updates/", "crm", None),
    ("/api/crm/activity/", "crm", SAFE),
    ("/api/crm/steps/", "crm", None),
    ("/api/crm/contacts/", ("crm", "billing"), None),
    ("/api/crm/projects/", ("crm", "billing"), SAFE),
    ("/api/crm/payments/", "billing", None),
    ("/api/crm/licences/", "billing", None),
    # meetings / reports
    ("/api/meetings/", "meetings", None),  # writes: MeetingViewSet.staff_only_actions
    ("/api/meeting-entities/", "meetings", SAFE),
    ("/api/reports/", "reports", SAFE),  # delete is staff-only
    # wiki / LLM wiki / Drive (each keeps its own inner rules)
    ("/api/wiki-docs/", "wiki", None),
    ("/api/knowledge/", "llm_wiki", SAFE),
    ("/api/drive/", "drive", None),  # shares: IsAdminUser on DriveShareView
    # operations
    ("/api/integrations/routines/", "operations", None),
    ("/api/integrations/events/", "operations", None),  # PATCH = triage
    # Source and service setup lives in staff-only settings pages.
    ("/api/integrations/event-sources/", "operations", SAFE),
    ("/api/integrations/services/", "operations", SAFE),
)

_API_BY_LENGTH = sorted(API_MODULES, key=lambda row: len(row[0]), reverse=True)


def api_rule(path: str):
    """The ``API_MODULES`` row governing ``path`` (longest prefix), or None."""
    return next((row for row in _API_BY_LENGTH if path.startswith(row[0])), None)


class ModuleAccessMiddleware:
    """Refuse a non-staff user any ``/api/`` route outside ``API_MODULES``, or
    one whose module they don't hold.

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
            and not _api_allows(user, path, request.method)
        ):
            return JsonResponse({"detail": "You don't have access to this."}, status=403)
        return self.get_response(request)


def _api_allows(user, path: str, method: str) -> bool:
    rule = api_rule(path)
    if rule is None:
        return False
    _, module, methods = rule
    if methods is not None and method not in methods:
        return False
    if module is None:
        return True
    wanted = (module,) if isinstance(module, str) else module
    return any(has_module(user, m) for m in wanted)


class StaffOnlyActions(BasePermission):
    """Restrict the view's ``staff_only_actions`` to staff."""

    def has_permission(self, request, view):
        return view.action not in getattr(view, "staff_only_actions", ()) or has_full_access(
            request.user
        )


def has_full_access(user) -> bool:
    return bool(user is not None and (user.is_staff or user.is_superuser))


def _check_module(module: str) -> None:
    # A typo (or a field name passed where the module goes) must fail loudly,
    # not silently scope everything away.
    if module not in MODULES:
        raise ValueError(f"Unknown module {module!r}.")


def user_modules(user) -> frozenset[str]:
    """Every module for staff; the profile's list (unknown keys dropped)
    otherwise. Cached on the user object — it is read many times per request,
    and a fresh request loads a fresh user."""
    if user is None or not user.is_authenticated:
        return frozenset()
    if has_full_access(user):
        return frozenset(MODULES)
    cached = getattr(user, "_cyt_modules", None)
    if cached is None:
        from .models import UserProfile

        raw = UserProfile.objects.filter(user=user).values_list("modules", flat=True).first()
        cached = frozenset(m for m in raw if m in MODULES) if isinstance(raw, list) else frozenset()
        user._cyt_modules = cached
    return cached


def has_module(user, module: str) -> bool:
    _check_module(module)
    return module in user_modules(user)


def member_project_ids(user) -> set[int] | None:
    """The user's projects regardless of module (``None`` = all, for staff).
    Only for directory data such as the project list — scope rows with
    ``visible_project_ids``."""
    if has_full_access(user):
        return None
    if user is None or not user.is_authenticated:
        return set()
    # Cached like ``user_modules``: serializers ask once per row.
    cached = getattr(user, "_cyt_projects", None)
    if cached is None:
        cached = frozenset(user.member_projects.values_list("pk", flat=True))
        user._cyt_projects = cached
    return set(cached)


def visible_project_ids(user, module: str) -> set[int] | None:
    """Projects whose ``module`` rows the user sees. ``None`` means
    unrestricted: staff, or a module-only module the user holds."""
    _check_module(module)
    if has_full_access(user):
        return None
    if not has_module(user, module):
        return set()
    if module in MODULE_ONLY:
        return None
    return member_project_ids(user)


def can_see_project(user, project_id: int | None, module: str) -> bool:
    ids = visible_project_ids(user, module)
    return ids is None or project_id in ids


def restrict_to_projects(qs: QuerySet, user, module: str, field: str = "project") -> QuerySet:
    ids = visible_project_ids(user, module)
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

    projects = visible_project_ids(user, "wiki")
    if projects is None:
        return None
    if not has_module(user, "wiki"):
        return set()
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
    if not has_module(user, "drive"):
        return set()
    return set(
        DriveFile.objects.filter(Q(uploaded_by=user) | Q(shared_with=user))
        .values_list("key", flat=True)
        .distinct()
    )


def can_reach_drive(user, key: str) -> bool:
    """A key the user uploaded or was shared — or anything inside a folder
    (a ``DriveFile`` key ending ``/``) they uploaded or were shared."""
    visible = visible_drive_keys(user)
    if visible is None:
        return True
    return key in visible or any(f.endswith("/") and key.startswith(f) for f in visible)


def visible_knowledge_slugs(user) -> set[str] | None:
    """LLM-wiki slugs a non-staff user can read (``None`` = all): every
    project the page is filed under must be one of theirs."""
    from collections import defaultdict

    from apps.drive.models import KnowledgePageProject

    projects = visible_project_ids(user, "llm_wiki")
    if projects is None:
        return None
    if not has_module(user, "llm_wiki"):
        return set()
    filed: dict[str, set[int]] = defaultdict(set)
    for slug, project_id in KnowledgePageProject.objects.values_list("slug", "project_id"):
        filed[slug].add(project_id)
    return {slug for slug, ids in filed.items() if ids <= projects}


def scope_for_caller(qs: QuerySet, user, module: str, field: str = "project") -> QuerySet:
    """``restrict_to_projects`` for MCP, where ``user=None`` is a user-less
    operator credential (legacy token, stdio) and stays unrestricted."""
    _check_module(module)
    return qs if user is None else restrict_to_projects(qs, user, module, field)
