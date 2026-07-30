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
import contextvars

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")

django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import URLRouter  # noqa: E402

from apps.tasks.routing import websocket_urlpatterns  # noqa: E402
from apps.wiki.routing import (  # noqa: E402
    websocket_urlpatterns as wiki_ws_urlpatterns,
)

logger = logging.getLogger(__name__)

# Authenticated user for the current MCP *session*, for the stdio transport.
#
# Do not read this directly from tool code over HTTP: the streamable-HTTP session
# manager copies the context once per session, so this value is pinned to
# whoever opened the session rather than whoever is making the current call.
# `apps.mcp_server.server._get_mcp_user` reads the per-request ASGI scope first
# and only falls back to this.
mcp_authenticated_user: contextvars.ContextVar = contextvars.ContextVar(
    "mcp_authenticated_user", default=None
)

_channels_ws = AuthMiddlewareStack(
    URLRouter(
        websocket_urlpatterns + wiki_ws_urlpatterns
    )
)

# ---------------------------------------------------------------------------
# MCP app
# ---------------------------------------------------------------------------

_mcp_app = None

#: Set once the MCP app has answered our synthetic lifespan.startup. Every /mcp
#: request awaits it, so none can reach an uninitialized session manager.
#: Created lazily because it must be bound to the running event loop.
_mcp_ready: asyncio.Event | None = None
_mcp_lifespan_task = None

#: How long to wait for MCP startup before giving up and letting the request
#: through (where it will fail loudly) rather than hanging forever.
MCP_STARTUP_TIMEOUT_SECONDS = 10


def _build_mcp():
    try:
        from apps.mcp_server.server import mcp
        return mcp.streamable_http_app()
    except Exception:
        logger.exception("Failed to build MCP app")
        return None


_mcp_app = _build_mcp()


async def _ensure_mcp_lifespan():
    """Drive a synthetic ASGI lifespan so the MCP app initializes its task group.

    Daphne never emits lifespan events, so we synthesize ``lifespan.startup`` on
    the first ``/mcp`` request and keep the lifespan coroutine alive for the rest
    of the process — the streamable-HTTP session manager's task group lives
    inside it. Do not remove this.

    Callers **await readiness** rather than sleeping a fixed interval. The
    earlier version flipped an `_mcp_initialized` flag before starting the task
    and then slept 0.1s, which meant two requests arriving together at cold
    start both skipped the wait and the second hit
    ``RuntimeError: Task group is not initialized`` → 500. Concurrent first
    requests are the norm, not an edge case: a client opens its session and
    immediately starts calling.
    """
    global _mcp_ready, _mcp_lifespan_task
    if not _mcp_app:
        return

    if _mcp_ready is None:
        # No await between the check and the assignment, so on a single-threaded
        # event loop exactly one caller can win this branch.
        _mcp_ready = asyncio.Event()
        ready = _mcp_ready
        startup_sent = asyncio.Event()
        shutdown_triggered = asyncio.Event()

        async def receive():
            # Send startup once, then block forever — shutdown only happens when
            # the process exits, at which point this task is discarded.
            if not startup_sent.is_set():
                startup_sent.set()
                return {"type": "lifespan.startup"}
            await shutdown_triggered.wait()
            return {"type": "lifespan.shutdown"}

        async def send(message):
            msg_type = message.get("type")
            if msg_type == "lifespan.startup.complete":
                ready.set()
            elif msg_type == "lifespan.startup.failed":
                # Unblock the waiters; the request will then fail visibly
                # instead of timing out silently.
                logger.error("MCP lifespan startup failed: %s", message.get("message"))
                ready.set()

        # Held in a module global so the task isn't garbage-collected mid-flight.
        _mcp_lifespan_task = asyncio.create_task(
            _mcp_app({"type": "lifespan"}, receive, send)
        )

    try:
        await asyncio.wait_for(
            _mcp_ready.wait(), timeout=MCP_STARTUP_TIMEOUT_SECONDS
        )
    except TimeoutError:
        logger.error(
            "MCP app did not signal lifespan startup within %ss; "
            "forwarding the request anyway",
            MCP_STARTUP_TIMEOUT_SECONDS,
        )


async def _send_mcp_401(scope, send):
    """Emit the 401 that starts OAuth discovery.

    The ``resource_metadata`` parameter is what turns a bare rejection into a
    usable hint: a spec-compliant MCP client reads it, fetches the protected
    resource metadata, finds the authorization server and runs the flow. It must
    name *this* deployment's origin — it used to be a hardcoded
    ``tm-api.cytsoftware.com``, which made OAuth impossible anywhere else.
    """
    from core.oauth_meta import resource_metadata_url

    metadata_url = resource_metadata_url(_scope_origin(scope))
    challenge = 'Bearer realm="mcp", error="invalid_token"'
    if metadata_url:
        challenge += f', resource_metadata="{metadata_url}"'

    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [
            [b"content-type", b"application/json"],
            [b"www-authenticate", challenge.encode()],
        ],
    })
    await send({
        "type": "http.response.body",
        "body": b'{"error":"invalid_token","error_description":'
                b'"A valid OAuth access token or MCP personal access token is required."}',
    })


def _scope_origin(scope):
    """Best-effort public origin for an ASGI scope, as an ``http[s]://host`` str.

    Only used when ``BACKEND_PUBLIC_URL`` is unset — there is no Django request
    object at this layer, so the Host / X-Forwarded-* headers are all we have.
    """
    headers = {k.lower(): v for k, v in scope.get("headers", [])}
    host = headers.get(b"x-forwarded-host") or headers.get(b"host")
    if not host:
        return None
    proto = headers.get(b"x-forwarded-proto")
    scheme = proto.decode().split(",")[0].strip() if proto else scope.get("scheme", "http")
    return f"{scheme}://{host.decode().split(',')[0].strip()}"


async def _handle_mcp(scope, receive, send):
    """Authenticate, then forward to the MCP app.

    All credential handling lives in :mod:`apps.mcp_server.auth`; this function
    only translates its verdict into ASGI.

    The authenticated user is published two ways:

    * on the **scope dict** — the source of truth. The streamable-HTTP session
      manager spawns one long-lived task per session and copies the context at
      *session creation*, so a module-level ContextVar set here would be frozen
      to whoever opened the session. The MCP SDK threads the per-message
      Starlette ``Request`` through to tool handlers, and that ``Request`` wraps
      this very dict, so reading it back there is exact per-request.
      See ``apps.mcp_server.server._get_mcp_user``.
    * on the **ContextVar** — retained for the stdio transport, which has no
      ASGI scope at all.
    """
    from apps.mcp_server.auth import (
        SCOPE_KIND_KEY,
        SCOPE_SCOPES_KEY,
        SCOPE_USER_KEY,
        authenticate_mcp_request,
    )

    headers = {k.lower(): v for k, v in scope.get("headers", [])}
    auth_header = headers.get(b"authorization", b"").decode(errors="replace")

    auth = await authenticate_mcp_request(auth_header)
    if auth is None:
        logger.info(
            "MCP request rejected path=%s method=%s has_auth=%s",
            scope.get("path"),
            scope.get("method"),
            bool(auth_header),
        )
        await _send_mcp_401(scope, send)
        return

    scope[SCOPE_USER_KEY] = auth.user
    scope[SCOPE_SCOPES_KEY] = auth.scopes
    scope[SCOPE_KIND_KEY] = auth.kind
    mcp_authenticated_user.set(auth.user)

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
