"""MCP/OAuth management URLs (mounted at /api/ by core/urls.py).

``SimpleRouter``, not ``DefaultRouter`` — a second router under the same ``api/``
prefix would register a clashing ``api-root`` view (see
``apps/webhooks/urls.py`` for the same note).
"""

from django.urls import path
from rest_framework.routers import SimpleRouter

from .oauth_views import (
    McpAccessTokenViewSet,
    OAuthAuthorizeRequestView,
    OAuthConnectionViewSet,
)

router = SimpleRouter()
router.register(r"mcp/tokens", McpAccessTokenViewSet, basename="mcp-token")
router.register(
    r"oauth/connections", OAuthConnectionViewSet, basename="oauth-connection"
)

urlpatterns = [
    path(
        "oauth/authorize-request/",
        OAuthAuthorizeRequestView.as_view(),
        name="oauth-authorize-request",
    ),
    *router.urls,
]
