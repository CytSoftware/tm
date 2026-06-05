"""GitHub webhook → task-tracker glue (P0 scope).

Responsibilities:

* :func:`extract_task_keys` — scan PR title/body/branch for task references
  belonging to a specific project. Case-insensitive, robust to unpadded
  digits, filtered against actual task existence.
* :func:`apply_pull_request_event` — turn a parsed ``pull_request`` payload
  into ``TaskPullRequest`` upserts and broadcast ``task.updated`` so
  connected browsers refetch. P0 does not move tasks between columns; the
  P1 rule engine will plug in after the upsert step.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from django.db import transaction
from django.utils.dateparse import parse_datetime

from apps.tasks.broadcast import broadcast_task_event
from apps.tasks.models import Project, Task

from .models import ProjectRepository, TaskPullRequest

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Task-key extraction
# ---------------------------------------------------------------------------
#
# Built per-project at call time rather than hardcoded: ``Project.prefix`` has
# no validator (yet), so prefixes can be lowercase or short. Matching is
# case-insensitive, boundaries use an alphanumeric lookaround so ``CYT-001``
# inside ``ABCCYT-001X`` does not match.


def extract_task_keys(project: Project, *text_sources: str | None) -> list[str]:
    """Return the set of task keys in ``text_sources`` that exist in ``project``.

    Keys are normalized to the canonical zero-padded form (e.g. ``CYT-1`` →
    ``CYT-001``). Unknown keys are silently dropped.
    """
    if not project.prefix:
        return []
    pattern = re.compile(
        rf"(?<![A-Za-z0-9]){re.escape(project.prefix)}-(\d+)(?![A-Za-z0-9])",
        re.IGNORECASE,
    )
    candidates: set[str] = set()
    for text in text_sources:
        if not text:
            continue
        for match in pattern.finditer(text):
            digits = match.group(1).lstrip("0") or "0"
            candidates.add(f"{project.prefix}-{digits.zfill(3)}")
    if not candidates:
        return []
    existing = list(
        Task.objects.filter(project=project, key__in=candidates).values_list(
            "key", flat=True
        )
    )
    return sorted(existing)


# ---------------------------------------------------------------------------
# Pull-request event application
# ---------------------------------------------------------------------------


@dataclass
class PullRequestEventResult:
    projects_matched: int = 0
    tasks_linked: int = 0
    tasks_unlinked: int = 0
    broadcasted_project_ids: set[int] = field(default_factory=set)


def apply_pull_request_event(payload: dict[str, Any]) -> PullRequestEventResult:
    """Apply a parsed ``pull_request`` webhook event to the DB.

    Pipeline per matching ``ProjectRepository``:

    1. Refresh cached display fields (``repo_full_name``, ``default_branch``).
    2. Extract task keys from the PR title, body, and head branch.
    3. Upsert a ``TaskPullRequest`` row for every matched task.
    4. Reconcile: delete links for this ``(repo, pr_number)`` that no longer
       match any key (handles a PR whose title was edited to remove a key).
    5. Broadcast ``task.updated`` once per project so clients refetch.
    """
    pr = payload.get("pull_request") or {}
    repo = payload.get("repository") or {}
    repo_id = repo.get("id")
    if not isinstance(repo_id, int):
        logger.debug("github webhook: missing repository.id, dropping")
        return PullRequestEventResult()

    links = list(
        ProjectRepository.objects.filter(repo_id=repo_id).select_related("project")
    )
    if not links:
        logger.debug("github webhook: no ProjectRepository for repo_id=%s", repo_id)
        return PullRequestEventResult()

    pr_number = int(pr.get("number") or 0)
    if pr_number <= 0:
        logger.debug("github webhook: invalid pr number on repo_id=%s", repo_id)
        return PullRequestEventResult()

    pr_title = pr.get("title") or ""
    pr_body = pr.get("body") or ""
    head_ref = ((pr.get("head") or {}).get("ref")) or ""
    repo_full_name = (repo.get("full_name") or "")[:300]
    default_branch = (repo.get("default_branch") or "")[:200]

    result = PullRequestEventResult()

    for link in links:
        project = link.project

        updated_fields: list[str] = []
        if repo_full_name and link.repo_full_name != repo_full_name:
            link.repo_full_name = repo_full_name
            updated_fields.append("repo_full_name")
        if default_branch and link.default_branch != default_branch:
            link.default_branch = default_branch
            updated_fields.append("default_branch")
        if updated_fields:
            link.save(update_fields=updated_fields)

        keys = extract_task_keys(project, pr_title, pr_body, head_ref)
        matched_tasks = (
            list(Task.objects.filter(project=project, key__in=keys)) if keys else []
        )
        matched_ids = {t.id for t in matched_tasks}

        with transaction.atomic():
            for task in matched_tasks:
                _upsert_task_pr(task, link, pr, pr_number)

            stale_qs = TaskPullRequest.objects.filter(
                repository=link, pr_number=pr_number
            ).exclude(task_id__in=matched_ids)
            stale_count = stale_qs.count()
            if stale_count:
                stale_qs.delete()

        if matched_tasks:
            result.projects_matched += 1
            result.tasks_linked += len(matched_tasks)
        result.tasks_unlinked += stale_count

        if (matched_tasks or stale_count) and project.id is not None:
            # One broadcast per project is enough — the frontend invalidates
            # the whole per-project task list on any event.
            anchor_task = matched_tasks[0] if matched_tasks else None
            broadcast_task_event(
                project.id,
                "task.updated",
                {
                    "key": anchor_task.key if anchor_task else "",
                    "id": anchor_task.id if anchor_task else 0,
                },
            )
            result.broadcasted_project_ids.add(project.id)

    return result


def _upsert_task_pr(
    task: Task,
    repository: ProjectRepository,
    pr: dict[str, Any],
    pr_number: int,
) -> TaskPullRequest:
    head = pr.get("head") or {}
    base = pr.get("base") or {}
    user = pr.get("user") or {}
    defaults = {
        "pr_title": (pr.get("title") or "")[:500],
        "state": (pr.get("state") or "open")[:20],
        "merged": bool(pr.get("merged")),
        "is_draft": bool(pr.get("draft")),
        "head_ref": (head.get("ref") or "")[:200],
        "base_ref": (base.get("ref") or "")[:200],
        "html_url": pr.get("html_url") or "",
        "author_login": (user.get("login") or "")[:200],
        "opened_at": _parse_ts(pr.get("created_at")) or datetime.now(timezone.utc),
        "merged_at": _parse_ts(pr.get("merged_at")),
        "closed_at": _parse_ts(pr.get("closed_at")),
    }
    obj, _ = TaskPullRequest.objects.update_or_create(
        task=task,
        repository=repository,
        pr_number=pr_number,
        defaults=defaults,
    )
    return obj


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    return parse_datetime(str(value))
