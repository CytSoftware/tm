"""ASGI config for the Cyt task tracker.

Serves three protocols from a single Daphne process:
  1. Django HTTP (DRF API + admin)
  2. Django Channels WebSocket (live task updates)
  3. MCP over SSE at /mcp/ (remote LLM agent access, token-authenticated)

For Dokploy / production: run ``daphne core.asgi:application`` as the single
entrypoint. The MCP endpoint is at ``https://your-domain.com/mcp/sse`` and
accepts Bearer token auth via the ``CYT_MCP_TOKEN`` env var.

For local Claude Desktop: ``python manage.py mcp_serve`` still works over stdio.
"""

import os
import logging

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")

# IMPORTANT: resolve the HTTP application before importing anything that
# touches Django ORM models — this forces Django to finish app loading first.
django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from django.conf import settings  # noqa: E402

from apps.tasks.routing import websocket_urlpatterns  # noqa: E402

logger = logging.getLogger(__name__)


def _build_mcp_app():
    """Build the MCP SSE ASGI app with token auth middleware."""
    try:
        from apps.mcp_server.server import mcp

        raw_app = mcp.sse_app()

        async def mcp_with_auth(scope, receive, send):
            if scope["type"] == "http":
                token = getattr(settings, "CYT_MCP_TOKEN", "")
                if token:
                    headers = dict(scope.get("headers", []))
                    auth_header = headers.get(b"authorization", b"").decode()
                    if auth_header != f"Bearer {token}":
                        await send({
                            "type": "http.response.start",
                            "status": 401,
                            "headers": [[b"content-type", b"application/json"]],
                        })
                        await send({
                            "type": "http.response.body",
                            "body": b'{"detail":"Invalid or missing MCP token."}',
                        })
                        return

                # The SSE app has routes at /sse and /messages.
                # Strip /mcp prefix so routing matches, and set root_path
                # to /mcp so the SSE endpoint event sends the full path
                # (e.g. /mcp/messages/?session_id=...) back to the client.
                path = scope.get("path", "")
                if path.startswith("/mcp"):
                    scope = dict(
                        scope,
                        path=path[4:] or "/",
                        root_path="/mcp",
                    )

                await raw_app(scope, receive, send)
            elif scope["type"] == "lifespan":
                await raw_app(scope, receive, send)

        return mcp_with_auth
    except Exception:
        logger.exception("Failed to build MCP ASGI app")
        return None


mcp_app = _build_mcp_app()

_channels_app = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
})


async def application(scope, receive, send):
    path = scope.get("path", "")

    if scope["type"] == "http" and path.startswith("/mcp"):
        if mcp_app:
            await mcp_app(scope, receive, send)
        else:
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [[b"content-type", b"application/json"]],
            })
            await send({
                "type": "http.response.body",
                "body": b'{"detail":"MCP server unavailable."}',
            })
    elif scope["type"] == "lifespan":
        await _channels_app(scope, receive, send)
    else:
        await _channels_app(scope, receive, send)
