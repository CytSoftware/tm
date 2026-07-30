"""Authentication for the remote MCP endpoint (``/mcp``).

This is the single gate every HTTP MCP request passes through. ``core/asgi.py``
calls :func:`authenticate_mcp_request` and either forwards the request or emits
the 401 that kicks off OAuth discovery.

Three credential kinds are accepted, in this order:

1. **OAuth 2.0 access token** — issued by django-oauth-toolkit through the
   authorization-code + PKCE flow. Validated with DOT's own
   ``AccessToken.is_valid(scopes)``, so expiry *and* scope are both checked and
   a revoked token (DOT deletes the row) simply isn't found. This is the
   preferred credential: it names a real user, so writes are attributed and the
   user-scoped tools work.
2. **Personal access token** — :class:`apps.mcp_server.models.McpAccessToken`.
   Same guarantees for clients that have no browser to run OAuth in.
3. **Static ``CYT_MCP_TOKEN``** — legacy, deprecated. Matches no user, so writes
   fall back to a heuristic and user-scoped tools refuse to run.

Two deliberate behaviours worth knowing:

* **Fails closed.** A request with no ``Authorization`` header is rejected
  unless ``settings.MCP_ALLOW_ANONYMOUS`` (which defaults to ``DEBUG``).
  Previously an unset ``CYT_MCP_TOKEN`` left ``/mcp`` open in *any*
  environment, production included.
* **Scope enforcement is split.** Reaching the endpoint requires
  ``settings.MCP_REQUIRED_SCOPES`` (``["read"]``). Individual write tools
  additionally require ``write``, enforced at the choke point in
  ``tools.py``, because a read-only client should be able to connect and list
  things rather than being bounced at the door.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from asgiref.sync import sync_to_async
from django.conf import settings

logger = logging.getLogger(__name__)

#: Scope keys stashed on the ASGI scope. ``core/asgi.py`` writes them and
#: ``server.py::_get_mcp_user`` reads them back off the per-request Starlette
#: ``Request``, which wraps the very same dict.
SCOPE_USER_KEY = "cyt_mcp_user"
SCOPE_SCOPES_KEY = "cyt_mcp_scopes"
SCOPE_KIND_KEY = "cyt_mcp_auth_kind"


@dataclass
class McpAuth:
    """The outcome of authenticating one MCP request.

    ``user`` is ``None`` only for the legacy static token — every other accepted
    credential names a real user.
    """

    #: "oauth" | "pat" | "static" | "anonymous"
    kind: str
    user: object | None = None
    scopes: list[str] = field(default_factory=list)

    def allow_scopes(self, required) -> bool:
        return set(required or []).issubset(set(self.scopes))


def _parse_bearer(auth_header: str) -> str | None:
    """Extract a Bearer token, tolerating any capitalisation of the scheme.

    RFC 6750 §2.1 defines the scheme name as case-insensitive; the previous
    implementation compared against the literal ``"Bearer "`` and rejected
    clients that sent ``bearer``.
    """
    if not auth_header:
        return None
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def _authenticate_oauth(bearer: str, required_scopes) -> McpAuth | None:
    """Validate *bearer* as a django-oauth-toolkit access token."""
    import hashlib

    from oauth2_provider.models import AccessToken

    # Look up by the indexed sha256 checksum — the raw `token` column is an
    # un-indexed TextField, which is why DOT itself queries this way.
    checksum = hashlib.sha256(bearer.encode("utf-8")).hexdigest()
    try:
        token = AccessToken.objects.select_related("user", "application").get(
            token_checksum=checksum
        )
    except AccessToken.DoesNotExist:
        return None

    # is_valid() covers expiry *and* scope in one call. A revoked token is gone
    # from the table entirely (DOT deletes on revoke), so DoesNotExist above is
    # the revocation path.
    if not token.is_valid(required_scopes):
        logger.info(
            "MCP OAuth token rejected (user=%s expired=%s scopes=%r required=%r)",
            token.user_id,
            token.is_expired(),
            token.scope,
            required_scopes,
        )
        return None

    # A client-credentials token has no user, so it can't be attributed. Refuse
    # rather than silently falling through to the static-token branch.
    if token.user is None or token.application is None:
        logger.info("MCP OAuth token has no user or application; rejecting")
        return None

    return McpAuth(kind="oauth", user=token.user, scopes=token.scope.split())


def _authenticate_pat(bearer: str, required_scopes) -> McpAuth | None:
    """Validate *bearer* as a personal access token."""
    from .models import TOKEN_PREFIX, McpAccessToken, hash_mcp_token

    # Cheap pre-filter: skip the query entirely for tokens that aren't ours.
    if not bearer.startswith(TOKEN_PREFIX):
        return None

    try:
        token = McpAccessToken.objects.select_related("user").get(
            token_hash=hash_mcp_token(bearer)
        )
    except McpAccessToken.DoesNotExist:
        return None

    if not token.is_active:
        logger.info(
            "MCP personal token rejected (id=%s revoked=%s expired=%s)",
            token.pk,
            token.revoked_at is not None,
            token.is_expired,
        )
        return None

    if not token.allow_scopes(required_scopes):
        logger.info(
            "MCP personal token lacks required scopes (id=%s has=%r needs=%r)",
            token.pk,
            token.scopes,
            required_scopes,
        )
        return None

    if not token.user.is_active:
        logger.info("MCP personal token belongs to an inactive user; rejecting")
        return None

    token.touch()
    return McpAuth(kind="pat", user=token.user, scopes=list(token.scopes or []))


def _authenticate_sync(auth_header: str) -> McpAuth | None:
    """Resolve *auth_header* to an :class:`McpAuth`, or ``None`` to reject.

    Runs entirely sync so it can be wrapped once by ``sync_to_async`` — the DB
    lookups here would otherwise need separate thread hops.
    """
    required_scopes = list(getattr(settings, "MCP_REQUIRED_SCOPES", ["read"]))
    static_token = getattr(settings, "CYT_MCP_TOKEN", "") or ""
    bearer = _parse_bearer(auth_header)

    if bearer is None:
        # No usable credential. Only local dev may proceed unauthenticated.
        if getattr(settings, "MCP_ALLOW_ANONYMOUS", False):
            return McpAuth(kind="anonymous", user=None, scopes=required_scopes)
        return None

    auth = _authenticate_oauth(bearer, required_scopes)
    if auth is not None:
        return auth

    auth = _authenticate_pat(bearer, required_scopes)
    if auth is not None:
        return auth

    if static_token:
        # constant-time compare: this value is a long-lived shared secret, so
        # don't leak its content through comparison timing.
        import hmac

        if hmac.compare_digest(bearer, static_token):
            logger.info(
                "MCP request authenticated with the legacy static token — "
                "writes cannot be attributed to a user. Prefer OAuth or a "
                "personal access token."
            )
            # The static token is all-or-nothing; grant every configured scope
            # so it keeps behaving as it did before scope checks existed.
            return McpAuth(
                kind="static",
                user=None,
                scopes=list(settings.OAUTH2_PROVIDER["SCOPES"].keys()),
            )

    return None


authenticate_mcp_request = sync_to_async(_authenticate_sync)
