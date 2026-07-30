"""Root URL config.

The task tracker API lives under /api/. The Django admin is mounted at /admin/
for quick sanity checking during development.
"""

import json
import logging
import time
from urllib.parse import urlsplit

from django.conf import settings
from django.contrib import admin
from django.core.cache import cache
from django.http import JsonResponse
from django.urls import include, path, re_path
from django.views.decorators.csrf import csrf_exempt

from core.oauth_meta import LOCAL_HOSTS, public_base_url

logger = logging.getLogger(__name__)


def _scopes_supported() -> list[str]:
    return sorted(settings.OAUTH2_PROVIDER["SCOPES"].keys())


def oauth_metadata(request):
    """RFC 8414 OAuth Authorization Server Metadata.

    MCP clients discover OAuth endpoints from this well-known URL so they use
    ``/oauth/authorize/`` instead of guessing ``/authorize``.
    """
    base = public_base_url(request)
    return JsonResponse({
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize/",
        "token_endpoint": f"{base}/oauth/token/",
        "registration_endpoint": f"{base}/oauth/register/",
        "revocation_endpoint": f"{base}/oauth/revoke_token/",
        "introspection_endpoint": f"{base}/oauth/introspect/",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        # S256 only. "plain" used to be advertised here while
        # OAUTH2_PROVIDER["PKCE_REQUIRED"] rejected it, so any client that
        # believed us and chose plain failed at the authorize step.
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": [
            "client_secret_post",
            "client_secret_basic",
            "none",
        ],
        "scopes_supported": _scopes_supported(),
        "service_documentation": f"{settings.FRONTEND_URL}/settings/connections",
    })


def protected_resource_metadata(request):
    """RFC 9728 OAuth Protected Resource Metadata.

    The 401 from ``/mcp`` points here; clients read it to learn which
    authorization server protects the endpoint.
    """
    base = public_base_url(request)
    return JsonResponse({
        "resource": f"{base}/mcp",
        "resource_name": "Cyt Task Manager",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": _scopes_supported(),
    })


# ---------------------------------------------------------------------------
# RFC 7591 Dynamic Client Registration
# ---------------------------------------------------------------------------

#: Registrations allowed per client IP per window. Registration is necessarily
#: unauthenticated (a client has no credential yet), so this is the only thing
#: standing between a stranger and unbounded Application rows.
REGISTER_RATE_LIMIT = 10
REGISTER_RATE_WINDOW_SECONDS = 3600


def _redirect_uri_error(uri: str) -> str | None:
    """Return a reason string if *uri* is not an acceptable redirect target.

    django-oauth-toolkit only checks the scheme against
    ``ALLOWED_REDIRECT_URI_SCHEMES``, which cannot express "http is fine, but
    only on loopback". That distinction matters: ``http://127.0.0.1:1234/cb`` is
    how every CLI client receives its code, while ``http://example.com/cb`` would
    put an authorization code on the wire in clear text.
    """
    parts = urlsplit(uri)
    scheme = parts.scheme.lower()
    if not scheme:
        return "must be an absolute URI"
    if scheme not in settings.OAUTH2_PROVIDER["ALLOWED_REDIRECT_URI_SCHEMES"]:
        return f"scheme {scheme!r} is not allowed"
    if scheme == "http" and parts.hostname not in LOCAL_HOSTS:
        return "http is only allowed for loopback addresses; use https"
    if parts.fragment:
        return "must not contain a fragment"
    return None


def _register_error(code: str, description: str, status: int = 400):
    return JsonResponse({"error": code, "error_description": description}, status=status)


@csrf_exempt
def oauth_register(request):
    """RFC 7591 Dynamic Client Registration.

    MCP clients (claude.ai, Claude Code, Cursor, …) call this to self-provision a
    ``client_id`` before starting the OAuth flow, so a human never has to copy
    credentials around.

    Two long-standing traps, both handled below:

    * **The hashed secret.** django-oauth-toolkit hashes
      ``Application.client_secret`` on save (``ClientSecretField.pre_save`` →
      ``make_password``). The plaintext must be captured *before* ``save()`` and
      returned; reading ``app.client_secret`` afterwards yields the bcrypt hash,
      which makes the token exchange fail with an opaque error.
    * **Row growth.** Because that plaintext is unrecoverable, a confidential
      client cannot be given back an existing registration and must get a fresh
      row. A *public* client has no secret at all, so re-registration is
      idempotent and is deduped here — that covers claude.ai and Claude Code,
      which is what used to accumulate an Application per reconnect.
    """
    if request.method != "POST":
        return _register_error(
            "invalid_request", "Use POST to register a client.", status=405
        )

    # Rate limit per IP. locmem cache means this is per-process; that is enough
    # to blunt a naive loop, and a determined attacker still can't authorize
    # anything without a user completing consent.
    client_ip = (
        request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
        or request.META.get("REMOTE_ADDR", "unknown")
    )
    cache_key = f"oauth_register:{client_ip}"
    attempts = cache.get_or_set(cache_key, 0, REGISTER_RATE_WINDOW_SECONDS)
    if attempts >= REGISTER_RATE_LIMIT:
        logger.warning("oauth_register rate limit hit for ip=%s", client_ip)
        return _register_error(
            "invalid_request",
            "Too many client registrations. Try again later.",
            status=429,
        )
    try:
        cache.incr(cache_key)
    except ValueError:  # entry expired between get_or_set and incr
        cache.set(cache_key, 1, REGISTER_RATE_WINDOW_SECONDS)

    try:
        body = json.loads(request.body) if request.body else {}
    except (json.JSONDecodeError, ValueError):
        return _register_error("invalid_client_metadata", "Body must be JSON.")
    if not isinstance(body, dict):
        return _register_error("invalid_client_metadata", "Body must be a JSON object.")

    client_name = (body.get("client_name") or "MCP Client")[:200]
    redirect_uris = body.get("redirect_uris") or []
    grant_types = body.get("grant_types") or ["authorization_code", "refresh_token"]
    response_types = body.get("response_types") or ["code"]
    token_endpoint_auth_method = body.get(
        "token_endpoint_auth_method", "client_secret_post"
    )
    scope = body.get("scope") or " ".join(_scopes_supported())

    if not isinstance(redirect_uris, list) or not redirect_uris:
        return _register_error(
            "invalid_redirect_uri", "redirect_uris must be a non-empty array."
        )
    for uri in redirect_uris:
        if not isinstance(uri, str):
            return _register_error(
                "invalid_redirect_uri", "Each redirect_uri must be a string."
            )
        reason = _redirect_uri_error(uri)
        if reason:
            return _register_error("invalid_redirect_uri", f"{uri}: {reason}")

    from oauth2_provider.generators import generate_client_id, generate_client_secret
    from oauth2_provider.models import Application

    redirect_uris_str = " ".join(redirect_uris)
    is_public = token_endpoint_auth_method == "none"

    response_data = {
        "client_id_issued_at": int(time.time()),
        "client_name": client_name,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": token_endpoint_auth_method,
        "scope": scope,
    }

    if is_public:
        existing = Application.objects.filter(
            name=client_name,
            redirect_uris=redirect_uris_str,
            client_type=Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
        ).first()
        if existing is not None:
            logger.info(
                "oauth_register reusing public app id=%s client_id=%s",
                existing.pk, existing.client_id,
            )
            response_data["client_id"] = existing.client_id
            return JsonResponse(response_data, status=201)

    plain_client_secret = generate_client_secret()
    app = Application(
        name=client_name,
        client_id=generate_client_id(),
        client_secret=plain_client_secret,
        client_type=(
            Application.CLIENT_PUBLIC if is_public else Application.CLIENT_CONFIDENTIAL
        ),
        authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
        redirect_uris=redirect_uris_str,
        # Registration is not consent. The user approves this client on the
        # branded consent screen (apps.mcp_server.oauth_views), and thereafter
        # REQUEST_APPROVAL_PROMPT="auto" makes reconnects silent — so there is no
        # longer any reason to skip the screen outright.
        skip_authorization=False,
    )
    app.save()

    response_data["client_id"] = app.client_id
    if not is_public:
        # The plaintext we generated — NOT app.client_secret, which is the hash
        # produced by pre_save. See the docstring.
        response_data["client_secret"] = plain_client_secret
        response_data["client_secret_expires_at"] = 0  # never expires

    logger.info(
        "oauth_register created app id=%s client_id=%s public=%s name=%r",
        app.pk, app.client_id, is_public, client_name,
    )
    return JsonResponse(response_data, status=201)


# django-oauth-toolkit's base URLs only. The module's `urlpatterns` also bundles
# server-rendered application/token management views, which duplicate
# /settings/connections and are needless surface.
from oauth2_provider.urls import base_urlpatterns as _oauth2_base_urls  # noqa: E402

from apps.mcp_server.oauth_views import McpAuthorizationView  # noqa: E402

urlpatterns = [
    # Optional trailing slash on every discovery route: APPEND_SLASH can't help
    # here (it only *adds* one), and clients differ on whether they send it.
    re_path(
        r"^\.well-known/oauth-authorization-server(?:/mcp)?/?$",
        oauth_metadata,
    ),
    re_path(
        r"^\.well-known/oauth-protected-resource(?:/mcp)?/?$",
        protected_resource_metadata,
    ),
    path("oauth/register/", oauth_register),
    # Must precede the oauth2_provider include so our consent hand-off wins.
    path("oauth/authorize/", McpAuthorizationView.as_view(), name="mcp-authorize"),
    path("admin/", admin.site.urls),
    path("api/", include("apps.tasks.urls")),
    path("api/", include("apps.wiki.urls")),
    path("api/", include("apps.drive.urls")),          # /api/drive — B2 file browser
    path("api/", include("apps.knowledge.urls")),      # /api/knowledge — LLM wiki (read-only)
    path("api/", include("apps.webhooks.urls")),       # /api/webhooks — outbound webhook endpoints
    path("api/", include("apps.mcp_server.urls")),     # /api/mcp, /api/oauth — MCP auth management
    path("api/integrations/", include("apps.integrations.urls")),
    path(
        "oauth/",
        include((_oauth2_base_urls, "oauth2_provider"), namespace="oauth2_provider"),
    ),
]

# Serve MEDIA_ROOT through Daphne in both dev and prod. These uploads are
# low-volume, so they are not worth standing up a
# separate static-file proxy. If that changes, move this to Traefik/nginx.
from django.conf import settings as _settings
from django.urls import re_path as _re_path
from django.views.static import serve as _serve_static

urlpatterns += [
    _re_path(
        r"^media/(?P<path>.*)$",
        _serve_static,
        {"document_root": _settings.MEDIA_ROOT},
    ),
]
