"""Root URL config.

The task tracker API lives under /api/. The Django admin is mounted at /admin/
for quick sanity checking during development.
"""

import json

from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path
from django.views.decorators.csrf import csrf_exempt


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
    """
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        body = {}

    client_name = body.get("client_name", "MCP Client")
    redirect_uris = body.get("redirect_uris", [])
    grant_types = body.get("grant_types", ["authorization_code"])
    token_endpoint_auth_method = body.get(
        "token_endpoint_auth_method", "client_secret_post"
    )

    if isinstance(redirect_uris, list):
        redirect_uris_str = "\n".join(redirect_uris)
    else:
        redirect_uris_str = str(redirect_uris)

    from oauth2_provider.models import Application

    # Check if an app with this name + redirect URIs already exists
    existing = Application.objects.filter(
        name=client_name,
        redirect_uris=redirect_uris_str,
    ).first()

    if existing:
        app = existing
    else:
        from oauth2_provider.generators import (
            generate_client_id,
            generate_client_secret,
        )

        app = Application.objects.create(
            name=client_name,
            client_id=generate_client_id(),
            client_secret=generate_client_secret(),
            client_type=Application.CLIENT_CONFIDENTIAL
            if token_endpoint_auth_method != "none"
            else Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
            redirect_uris=redirect_uris_str,
            skip_authorization=False,
        )

    response_data = {
        "client_id": app.client_id,
        "client_name": app.name,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "token_endpoint_auth_method": token_endpoint_auth_method,
    }
    # Only include client_secret for confidential clients
    if app.client_type == Application.CLIENT_CONFIDENTIAL:
        response_data["client_secret"] = app.client_secret

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
