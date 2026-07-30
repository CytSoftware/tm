"""Public-URL derivation for OAuth metadata and the MCP 401 challenge.

Every RFC 8414 / RFC 9728 document and every ``WWW-Authenticate`` challenge we
emit has to name this deployment's *externally reachable* origin. Getting that
wrong is not cosmetic: an MCP client follows those URLs literally, so a stale or
hardcoded origin means discovery lands on the wrong host and the OAuth flow
never starts.

Two sources, in priority order:

1. ``settings.BACKEND_PUBLIC_URL`` — an explicit origin (e.g.
   ``https://tm-api.cytsoftware.com``). Set this in production. It is the only
   source that is correct unconditionally, because it doesn't depend on what the
   reverse proxy chose to forward.
2. The incoming request. Django views pass their ``HttpRequest``; the MCP ASGI
   gate has no request object that early, so it passes a bare origin string
   assembled from the Host / X-Forwarded-* headers. Either way a non-local host
   is forced to HTTPS — a public deployment is never plain HTTP, and Traefik
   terminates TLS before us.

This module replaces the same http→https string surgery that used to be
duplicated across two views in ``core/urls.py``, plus the hardcoded
``https://tm-api.cytsoftware.com`` baked into two 401 branches in ``core/asgi.py``.
"""

from __future__ import annotations

from django.conf import settings

#: Hosts that are legitimately reachable over plain HTTP.
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"})


def _host_of(origin: str) -> str:
    """The bare hostname of *origin*, without scheme, port or path."""
    host = origin.split("://", 1)[-1].split("/", 1)[0]
    if host.startswith("["):  # IPv6 literal, e.g. [::1]:8000
        return host.partition("]")[0] + "]"
    return host.split(":", 1)[0]


def _normalize(origin: str | None) -> str:
    """Strip the trailing slash and force HTTPS for non-local hosts."""
    if not origin:
        return ""
    origin = origin.rstrip("/")
    # Compare the host portion only, so a domain that merely *contains*
    # "localhost" (e.g. https://localhost.example.com) isn't treated as local.
    if origin.startswith("http://") and _host_of(origin) not in LOCAL_HOSTS:
        origin = "https://" + origin[len("http://") :]
    return origin


def public_base_url(source=None) -> str:
    """Return this deployment's public origin, with no trailing slash.

    *source* may be a Django ``HttpRequest``, a plain origin string, or ``None``
    when the caller has neither — in which case ``BACKEND_PUBLIC_URL`` is the
    only available source and ``""`` is returned if it is unset. Callers must
    treat ``""`` as "omit the field" rather than advertising a guessed URL.
    """
    configured = (getattr(settings, "BACKEND_PUBLIC_URL", "") or "").strip()
    if configured:
        return _normalize(configured)

    if source is None:
        return ""
    if isinstance(source, str):
        return _normalize(source)
    return _normalize(source.build_absolute_uri("/"))


def resource_metadata_url(source=None) -> str:
    """The RFC 9728 protected-resource metadata URL for the MCP endpoint.

    Returns ``""`` when the origin can't be determined, so callers omit the
    ``resource_metadata`` challenge parameter rather than emit a broken URL.
    """
    base = public_base_url(source)
    return f"{base}/.well-known/oauth-protected-resource/mcp" if base else ""
