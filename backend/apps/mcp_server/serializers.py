"""Serializers for MCP personal access tokens.

The plaintext token is reveal-once (same contract as the webhook signing secret
in ``apps.webhooks.serializers``): it is injected into the create response by the
view and never appears on a model field, so it cannot leak through list/detail
responses.
"""

from __future__ import annotations

from django.conf import settings
from django.utils import timezone
from rest_framework import serializers

from .models import McpAccessToken


def _valid_scopes() -> set[str]:
    return set(settings.OAUTH2_PROVIDER["SCOPES"].keys())


class McpAccessTokenSerializer(serializers.ModelSerializer):
    """Read shape: everything except anything that could reconstruct the token."""

    is_expired = serializers.BooleanField(read_only=True)

    class Meta:
        model = McpAccessToken
        fields = (
            "id",
            "name",
            "token_prefix",
            "scopes",
            "created_at",
            "last_used_at",
            "expires_at",
            "is_expired",
        )
        read_only_fields = fields
        # ``token_hash`` intentionally absent.


class McpAccessTokenCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = McpAccessToken
        fields = ("id", "name", "scopes", "expires_at")

    def validate_name(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Give the token a name.")
        return value

    def validate_scopes(self, value: list) -> list:
        if not value:
            raise serializers.ValidationError(
                "Grant at least one scope."
            )
        unknown = sorted(set(value) - _valid_scopes())
        if unknown:
            raise serializers.ValidationError(
                f"Unknown scope(s): {unknown}. Allowed: {sorted(_valid_scopes())}."
            )
        return value

    def validate_expires_at(self, value):
        if value is not None and value <= timezone.now():
            raise serializers.ValidationError("Expiry must be in the future.")
        return value

    def validate(self, attrs):
        # Default rather than require: most tokens want full access, and the UI
        # only offers a read-only checkbox as an opt-in.
        attrs.setdefault("scopes", sorted(_valid_scopes()))
        return attrs


class McpAccessTokenCreatedSerializer(McpAccessTokenSerializer):
    """Create response. The view adds the plaintext ``token`` field."""

    class Meta(McpAccessTokenSerializer.Meta):
        pass
