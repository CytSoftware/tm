"""Resolve shipped tasks from immutable dev promotion heads, never branch tips."""

from contextlib import contextmanager
import re

import httpx

from .github import GitHubUnavailable, app_jwt, request
from .models import ProjectRepository, PullRequestSnapshot, TaskPullRequest


def is_promotion(pr):
    return (
        pr.get("merged") is True
        and (pr.get("base") or {}).get("ref") == "main"
        and (pr.get("head") or {}).get("ref") == "dev"
        and (pr.get("head", {}).get("repo") or {}).get("id") is not None
        and (pr.get("head", {}).get("repo") or {}).get("id")
        == (pr.get("base", {}).get("repo") or {}).get("id")
    )


@contextmanager
def repository_reader(repo_id):
    name = ProjectRepository.objects.filter(repo_id=repo_id).values_list("repo_full_name", flat=True).first()
    with httpx.Client(base_url="https://api.github.com", timeout=15, follow_redirects=True,
                      headers={"Accept": "application/vnd.github+json"}) as client:
        installation = request(client, "GET", f"/repos/{name}/installation", app_jwt())
        token = request(client, "POST", f"/app/installations/{installation['id']}/access_tokens", app_jwt(),
                        json={"repository_ids": [repo_id], "permissions": {"contents": "read", "pull_requests": "read"}})["token"]

        def read(path, **kwargs):
            return request(client, "GET", f"/repositories/{repo_id}/{path}", token, **kwargs)

        yield read


def contains(read, commit, head):
    if not all(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40,64}", sha) for sha in (commit, head)):
        raise GitHubUnavailable("Missing merge commit evidence; cannot determine shipped tasks.")
    if commit == head:
        return True
    comparison = read(f"compare/{commit}...{head}", params={"per_page": 1})
    return comparison.get("status") in ("ahead", "identical")


def resolve_promotion(repo_id, pr):
    """Return inferred task IDs for a promotion and whether this dev PR shipped.

    A snapshot is retained even when a release has no task references, so a
    task reference added to a feature PR after release can still be resolved.
    API failures propagate: the webhook must remain retryable, not claim success.
    """
    if pr.get("merged") is not True:
        return set(), False
    if is_promotion(pr):
        candidates = list(TaskPullRequest.objects.filter(
            repository__repo_id=repo_id, base_ref="dev", merged=True,
        ).exclude(task__column__kind__in=["done", "other"]).values_list("pr_number", "task_id"))
        existing_ids = set(TaskPullRequest.objects.filter(
            repository__repo_id=repo_id, pr_number=pr["number"], merged=True,
        ).values_list("task_id", flat=True))
        if not candidates:
            return existing_ids, False
        snapshots = {s.pr_number: s.payload for s in PullRequestSnapshot.objects.filter(
            repo_id=repo_id, pr_number__in={number for number, _ in candidates},
        )}
        included = set()
        with repository_reader(repo_id) as read:
            for number in sorted({number for number, _ in candidates}):
                feature = snapshots.get(number) or {}
                # Existing task links predate snapshots. Read their actual merge
                # commits instead of guessing inclusion from timestamps.
                if not feature.get("merge_commit_sha") or not feature.get("merged"):
                    feature = read(f"pulls/{number}")
                if feature.get("merged") and contains(read, feature.get("merge_commit_sha"), pr["head"].get("sha")):
                    included.add(number)
        return existing_ids | {task_id for number, task_id in candidates if number in included}, False

    if (pr.get("base") or {}).get("ref") != "dev":
        return set(), False
    promotions = [s.payload for s in PullRequestSnapshot.objects.filter(
        repo_id=repo_id, payload__merged=True, payload__base__ref="main", payload__head__ref="dev",
    ) if is_promotion(s.payload)]
    if not promotions:
        return set(), False
    with repository_reader(repo_id) as read:
        for promotion in promotions:
            if contains(read, pr.get("merge_commit_sha"), promotion["head"].get("sha")):
                return set(), True
    return set(), False
