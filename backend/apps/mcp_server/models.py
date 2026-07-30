"""Personal access tokens for the remote MCP endpoint.

Why these exist alongside OAuth: OAuth is the right answer for a browser-driven
client (claude.ai, Cursor) because it can open a consent screen. A headless
client — Claude Code reading ``.mcp.json``, a cron job, a CI step — has no
browser, and the historical answer was the single shared ``CYT_MCP_TOKEN``. That
token cannot be attributed to a user (writes fell back to "first superuser"),
cannot be revoked without a redeploy, and made the eight user-scoped tools
(``list_focus``, ``register_webhook``, …) fail outright.

An ``McpAccessToken`` is the per-user replacement: minted from Settings →
Connections, shown once, attributable, independently revocable, optionally
expiring.

Storage: only a SHA-256 of the token is kept, so a database leak does not yield
usable credentials. Lookup is a single indexed query on that hash — there is no
plaintext column to scan and no per-row password comparison. ``token_prefix``
holds the first few public characters purely so the UI can show *which* token a
row is without being able to reconstruct it.
"""

from __future__ import annotations

import hashlib
import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone

#: Human-recognisable prefix, so a leaked string is greppable and obviously ours.
TOKEN_PREFIX = "cyt_mcp_"

#: Characters of the generated secret retained in ``token_prefix`` for display.
DISPLAY_CHARS = 6


def hash_mcp_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_mcp_token() -> tuple[str, str, str]:
    """Mint a token. Returns ``(plaintext, prefix, sha256_hex)``.

    The plaintext is returned exactly once — to the create endpoint, which
    passes it straight to the user and never persists it.
    """
    secret = secrets.token_urlsafe(32)
    plaintext = f"{TOKEN_PREFIX}{secret}"
    return (
        plaintext,
        f"{TOKEN_PREFIX}{secret[:DISPLAY_CHARS]}",
        hash_mcp_token(plaintext),
    )


class McpAccessToken(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="mcp_tokens",
    )
    name = models.CharField(
        max_length=200,
        help_text="What this token is for, e.g. 'Claude Code on the laptop'.",
    )
    token_prefix = models.CharField(
        max_length=32,
        editable=False,
        help_text="Public leading characters, for display only.",
    )
    token_hash = models.CharField(
        max_length=64,
        unique=True,
        editable=False,
        help_text="SHA-256 of the full token. The plaintext is never stored.",
    )
    scopes = models.JSONField(
        default=list,
        blank=True,
        help_text='Granted scopes, e.g. ["read", "write"].',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # Deliberately coarse: updated at most once a minute (see touch()), because
    # every single MCP tool call would otherwise cost a write.
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Optional expiry. Null means the token never expires.",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    #: How stale ``last_used_at`` is allowed to get before we write again.
    TOUCH_INTERVAL_SECONDS = 60

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.token_prefix}…)"

    @property
    def is_expired(self) -> bool:
        return self.expires_at is not None and self.expires_at <= timezone.now()

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None and not self.is_expired

    def allow_scopes(self, required) -> bool:
        """True if this token carries every scope in *required*.

        Mirrors ``oauth2_provider.models.AccessToken.allow_scopes`` so the MCP
        gate can treat OAuth tokens and personal tokens identically.
        """
        granted = set(self.scopes or [])
        return set(required or []).issubset(granted)

    def touch(self) -> None:
        """Record use, at most once per ``TOUCH_INTERVAL_SECONDS``."""
        now = timezone.now()
        if (
            self.last_used_at is not None
            and (now - self.last_used_at).total_seconds() < self.TOUCH_INTERVAL_SECONDS
        ):
            return
        self.last_used_at = now
        # update_fields keeps this a one-column write and avoids clobbering
        # anything a concurrent request changed.
        self.save(update_fields=["last_used_at"])

    def revoke(self) -> None:
        if self.revoked_at is None:
            self.revoked_at = timezone.now()
            self.save(update_fields=["revoked_at"])
