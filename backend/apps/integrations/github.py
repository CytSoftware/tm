"""Read the repositories accessible to the company's GitHub App."""

import time

import httpx
import jwt
from django.conf import settings
from django.core.cache import cache
from rest_framework.exceptions import APIException


class GitHubUnavailable(APIException):
    status_code = 503
    default_detail = "GitHub is unavailable. Try again shortly."


def app_jwt():
    if not settings.GITHUB_APP_ID or not settings.GITHUB_PRIVATE_KEY:
        raise GitHubUnavailable("Configure the GitHub App ID and private key on the backend.")
    now = int(time.time())
    try:
        return jwt.encode(
            {"iat": now - 60, "exp": now + 540, "iss": settings.GITHUB_APP_ID},
            settings.GITHUB_PRIVATE_KEY,
            algorithm="RS256",
        )
    except (ValueError, TypeError, jwt.PyJWTError):
        raise GitHubUnavailable("The GitHub App private key is invalid.") from None


def request(client, method, path, token, **kwargs):
    try:
        response = client.request(
            method, path,
            headers={"Authorization": f"Bearer {token}"},
            **kwargs,
        )
    except httpx.HTTPError:
        raise GitHubUnavailable() from None
    if response.status_code in (401, 403):
        raise GitHubUnavailable("GitHub denied access. Check the App credentials, permissions, or rate limit.")
    if response.status_code >= 400:
        raise GitHubUnavailable()
    try:
        return response.json()
    except ValueError:
        raise GitHubUnavailable() from None


def pages(client, path, token, key=None):
    # Refuse an incomplete picker instead of silently omitting repositories.
    for page in range(1, 101):
        data = request(client, "GET", path, token, params={"per_page": 100, "page": page})
        rows = data[key] if key else data
        yield from rows
        if len(rows) < 100:
            return
    raise GitHubUnavailable("Too many GitHub results. Contact the workspace administrator.")


def available_repositories(*, refresh=False):
    token = app_jwt()
    cache_key = f"github:repositories:{settings.GITHUB_APP_ID}"
    if not refresh:
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
    repositories = []
    with httpx.Client(
        base_url="https://api.github.com", timeout=15,
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    ) as client:
        for installation in pages(client, "/app/installations", token):
            if installation.get("suspended_at"):
                continue
            installation_token = request(
                client, "POST", f"/app/installations/{installation['id']}/access_tokens", token,
                json={"permissions": {"metadata": "read"}},
            )["token"]
            for repo in pages(client, "/installation/repositories", installation_token, "repositories"):
                repositories.append({
                    "repo_id": repo["id"],
                    "repo_full_name": repo["full_name"],
                    "default_branch": repo["default_branch"],
                    "private": repo["private"],
                    "archived": repo["archived"],
                    "installation_id": installation["id"],
                    "account_login": installation["account"]["login"],
                    "account_type": installation["account"]["type"],
                })
    repositories.sort(key=lambda r: r["repo_full_name"].lower())
    cache.set(cache_key, repositories, 60)
    return repositories
