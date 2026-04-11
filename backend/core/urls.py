"""Root URL config.

The task tracker API lives under /api/. The Django admin is mounted at /admin/
for quick sanity checking during development.
"""

import json
import logging
import time

from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path
from django.views.decorators.csrf import csrf_exempt

logger = logging.getLogger(__name__)


def oauth_metadata(request):
    """RFC 8414 OAuth Authorization Server Metadata.

    MCP clients discover OAuth endpoints from this well-known URL so they
    use /oauth/authorize/ instead of guessing /authorize.
    """
    base = request.build_absolute_uri("/").rstrip("/")
    # Behind a reverse proxy (Traefik), the scheme is HTTP internally.
    # Force HTTPS in production.
    if base.startswith("http://") and not any(
        h in base for h in ("localhost", "127.0.0.1")
    ):
        base = "https://" + base[7:]
    return JsonResponse({
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize/",
        "token_endpoint": f"{base}/oauth/token/",
        "registration_endpoint": f"{base}/oauth/register/",
        "revocation_endpoint": f"{base}/oauth/revoke_token/",
        "introspection_endpoint": f"{base}/oauth/introspect/",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256", "plain"],
        "token_endpoint_auth_methods_supported": [
            "client_secret_post",
            "client_secret_basic",
            "none",
        ],
        "scopes_supported": ["read", "write"],
    })


@csrf_exempt
def oauth_register(request):
    """RFC 7591 Dynamic Client Registration.

    MCP clients (Claude, Cursor, etc.) call this to register themselves
    and get a client_id + client_secret before starting the OAuth flow.

    IMPORTANT: django-oauth-toolkit hashes Application.client_secret on save
    (ClientSecretField.pre_save → make_password). We MUST capture the
    plaintext secret before save() and return THAT to the client — reading
    app.client_secret after create() yields the bcrypt hash, which breaks
    the token exchange silently.
    """
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)

    try:
        body = json.loads(request.body) if request.body else {}
    except (json.JSONDecodeError, ValueError):
        body = {}

    logger.info("oauth_register request body: %s", body)

    client_name = body.get("client_name") or "MCP Client"
    redirect_uris = body.get("redirect_uris") or []
    grant_types = body.get("grant_types") or ["authorization_code", "refresh_token"]
    response_types = body.get("response_types") or ["code"]
    token_endpoint_auth_method = body.get(
        "token_endpoint_auth_method", "client_secret_post"
    )
    scope = body.get("scope", "read write")

    if isinstance(redirect_uris, list):
        redirect_uris_str = " ".join(redirect_uris)
    else:
        redirect_uris_str = str(redirect_uris)

    from oauth2_provider.generators import (
        generate_client_id,
        generate_client_secret,
    )
    from oauth2_provider.models import Application

    # Always mint a fresh application. Deduping is dangerous because we cannot
    # recover the plaintext secret from an existing row (it's hashed), so any
    # re-registration attempt would hand back an unusable secret.
    is_public = token_endpoint_auth_method == "none"
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
        # Auto-approve — MCP clients expect to complete the flow without a
        # separate consent click. The user explicitly initiated the connect
        # from the client side, which is the consent.
        skip_authorization=True,
    )
    app.save()

    response_data = {
        "client_id": app.client_id,
        "client_id_issued_at": int(time.time()),
        "client_name": app.name,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": token_endpoint_auth_method,
        "scope": scope,
    }
    if not is_public:
        # Return the plaintext secret we generated — NOT app.client_secret,
        # which is now the bcrypt hash produced by pre_save.
        response_data["client_secret"] = plain_client_secret
        response_data["client_secret_expires_at"] = 0  # never expires

    logger.info(
        "oauth_register created app id=%s client_id=%s public=%s",
        app.pk,
        app.client_id,
        is_public,
    )
    return JsonResponse(response_data, status=201)


def protected_resource_metadata(request):
    """RFC 9728 OAuth Protected Resource Metadata.

    MCP clients read this to discover which authorization server
    protects this resource (the MCP endpoint).
    """
    base = request.build_absolute_uri("/").rstrip("/")
    if base.startswith("http://") and not any(
        h in base for h in ("localhost", "127.0.0.1")
    ):
        base = "https://" + base[7:]
    return JsonResponse({
        "resource": f"{base}/mcp",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["read", "write"],
    })


urlpatterns = [
    path(".well-known/oauth-authorization-server", oauth_metadata),
    path(".well-known/oauth-protected-resource", protected_resource_metadata),
    path(".well-known/oauth-protected-resource/mcp", protected_resource_metadata),
    path("oauth/register/", oauth_register),
    path("admin/", admin.site.urls),
    path("api/", include("apps.tasks.urls")),
    path("oauth/", include("oauth2_provider.urls", namespace="oauth2_provider")),
]

# Serve MEDIA_ROOT in development so uploaded profile pictures render in the
# frontend without needing a reverse proxy.
from django.conf import settings as _settings
from django.conf.urls.static import static as _static

if _settings.DEBUG:
    urlpatterns += _static(_settings.MEDIA_URL, document_root=_settings.MEDIA_ROOT)
