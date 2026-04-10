"""ASGI config for the Cyt task tracker.

Serves three protocols from a single Daphne process:
  1. Django HTTP (DRF API + admin)
  2. Django Channels WebSocket (/ws/*)
  3. MCP over Streamable HTTP (/mcp)

The MCP streamable HTTP app requires ASGI lifespan events to initialize
its internal task group. We forward lifespan to it on startup.
"""

import os
import logging
import asyncio

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")

django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import URLRouter  # noqa: E402
from django.conf import settings  # noqa: E402

from apps.tasks.routing import websocket_urlpatterns  # noqa: E402

logger = logging.getLogger(__name__)

_channels_ws = AuthMiddlewareStack(URLRouter(websocket_urlpatterns))

# ---------------------------------------------------------------------------
# MCP app
# ---------------------------------------------------------------------------

_mcp_app = None
_mcp_initialized = False


def _build_mcp():
    try:
        from apps.mcp_server.server import mcp
        return mcp.streamable_http_app()
    except Exception:
        logger.exception("Failed to build MCP app")
        return None


_mcp_app = _build_mcp()


async def _ensure_mcp_lifespan():
    """Send a synthetic lifespan.startup to the MCP app so it initializes
    its task group. Daphne doesn't send lifespan events, so we do it manually
    on the first MCP request."""
    global _mcp_initialized
    if _mcp_initialized or not _mcp_app:
        return
    _mcp_initialized = True

    startup_complete = asyncio.Event()
    shutdown_triggered = asyncio.Event()

    async def receive():
        # Send startup, then wait forever (shutdown only on process exit)
        if not startup_complete.is_set():
            startup_complete.set()
            return {"type": "lifespan.startup"}
        await shutdown_triggered.wait()
        return {"type": "lifespan.shutdown"}

    async def send(message):
        pass  # Ignore startup.complete / shutdown.complete

    # Run the lifespan handler in the background — it stays alive for the
    # duration of the process, keeping the MCP task group open.
    asyncio.create_task(_mcp_app({"type": "lifespan"}, receive, send))
    # Give it a moment to start up
    await asyncio.sleep(0.1)


async def _handle_mcp(scope, receive, send):
    """Token auth + forward to MCP app."""
    token = getattr(settings, "CYT_MCP_TOKEN", "")
    if token and scope["type"] == "http":
        headers = dict(scope.get("headers", []))
        auth = headers.get(b"authorization", b"").decode()
        if auth != f"Bearer {token}":
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

    await _ensure_mcp_lifespan()
    await _mcp_app(scope, receive, send)


# ---------------------------------------------------------------------------
# Top-level ASGI application
# ---------------------------------------------------------------------------

async def application(scope, receive, send):
    scope_type = scope["type"]
    path = scope.get("path", "")

    if scope_type == "http" and path.startswith("/mcp"):
        if _mcp_app:
            await _handle_mcp(scope, receive, send)
        else:
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [[b"content-type", b"application/json"]],
            })
            await send({
                "type": "http.response.body",
                "body": b'{"detail":"MCP unavailable."}',
            })
    elif scope_type == "websocket":
        await _channels_ws(scope, receive, send)
    elif scope_type == "lifespan":
        # Daphne doesn't send lifespan, but handle it gracefully if it does.
        if _mcp_app:
            await _mcp_app(scope, receive, send)
        else:
            await receive()  # consume startup
            await send({"type": "lifespan.startup.complete"})
            await receive()  # consume shutdown
            await send({"type": "lifespan.shutdown.complete"})
    else:
        await django_asgi_app(scope, receive, send)
