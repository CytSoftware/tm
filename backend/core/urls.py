"""Root URL config.

The task tracker API lives under /api/. The Django admin is mounted at /admin/
for quick sanity checking during development.
"""

from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path


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
        "revocation_endpoint": f"{base}/oauth/revoke_token/",
        "introspection_endpoint": f"{base}/oauth/introspect/",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
        "scopes_supported": ["read", "write"],
    })


urlpatterns = [
    path(".well-known/oauth-authorization-server", oauth_metadata),
    path("admin/", admin.site.urls),
    path("api/", include("apps.tasks.urls")),
    path("oauth/", include("oauth2_provider.urls", namespace="oauth2_provider")),
]
