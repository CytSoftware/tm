"""The one read path and the one write path for reports — REST and MCP both
call these, so scoping and validation can't drift between them."""

from __future__ import annotations

from django.conf import settings
from django.db.models import Q, QuerySet

from apps.meetings.services import MeetingError, resolve_project
from apps.tasks.access import scope_for_caller

from .models import Report, pk_from_key

#: Reports are meant to be small self-contained pages; this stops a runaway
#: bot from parking megabytes of base64 in SQLite.
MAX_HTML_BYTES = 2 * 1024 * 1024


class ReportError(ValueError):
    pass


def report_url(report: Report) -> str:
    return f"{settings.FRONTEND_URL}/reports?r={report.key}"


def _project(ref):
    try:
        return resolve_project(ref)
    except MeetingError as exc:
        raise ReportError(str(exc)) from exc


def visible_reports(user, *, search: str = "", project=None) -> QuerySet[Report]:
    """Reports *user* may read, newest first, without the HTML body.

    ``user=None`` is a user-less operator credential and sees everything
    (see ``scope_for_caller``).
    """
    qs = scope_for_caller(Report.objects.select_related("project", "created_by"), user)
    if search:
        qs = qs.filter(Q(title__icontains=search) | Q(summary__icontains=search))
    if project not in (None, ""):
        qs = qs.filter(project=_project(project))
    return qs.defer("html")


def get_report(user, ref) -> Report:
    pk = pk_from_key(ref)
    report = scope_for_caller(Report.objects.select_related("project"), user).filter(pk=pk).first()
    if pk is None or report is None:
        raise ReportError(f"Report {ref!r} not found.")
    return report


def publish_report(*, title: str, summary: str, html: str, project=None, user=None) -> Report:
    title, summary = (title or "").strip(), (summary or "").strip()
    if not title:
        raise ReportError("title is required.")
    if not (html or "").strip():
        raise ReportError("html is required.")
    if len(html.encode()) > MAX_HTML_BYTES:
        raise ReportError(f"html is over {MAX_HTML_BYTES // 1024 // 1024} MB; inline less data.")
    return Report.objects.create(
        title=title[:300],
        summary=summary[:500],
        html=html,
        project=_project(project),
        created_by=user,
    )
