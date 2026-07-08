"""DRF serializers for webhook endpoints + deliveries.

``WebhookEndpointSerializer`` deliberately **excludes** ``secret`` — the
signing secret is reveal-once: it appears only in the create response and the
``rotate_secret`` action (both via ``WebhookEndpointCreatedSerializer``), so
it never shows up in list/detail responses or browser devtools.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from rest_framework import serializers

from .models import WEBHOOK_EVENT_TYPES, WebhookDelivery, WebhookEndpoint

#: Response bodies in delivery list responses are clipped to this length —
#: the API is for status inspection, not receiver-output archiving.
DELIVERY_RESPONSE_BODY_PREVIEW_CHARS = 500


class WebhookEndpointSerializer(serializers.ModelSerializer):
    class Meta:
        model = WebhookEndpoint
        fields = (
            "id",
            "name",
            "url",
            "event_types",
            "scope",
            "project",
            "include_self",
            "active",
            "consecutive_failures",
            "disabled_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "consecutive_failures",
            "disabled_at",
            "created_at",
            "updated_at",
        )
        # ``secret`` intentionally absent — reveal-once, see module docstring.

    def validate_url(self, value: str) -> str:
        scheme = urlsplit(value).scheme.lower()
        if scheme not in ("http", "https"):
            raise serializers.ValidationError("URL must use http or https.")
        return value

    def validate_event_types(self, value: list) -> list:
        allowed = set(WEBHOOK_EVENT_TYPES)
        bad = [v for v in value if v not in allowed]
        if bad:
            raise serializers.ValidationError(
                f"Unknown event type(s): {sorted(set(bad))}. "
                f"Allowed: {sorted(allowed)} (empty list = all)."
            )
        return value


class WebhookEndpointCreatedSerializer(WebhookEndpointSerializer):
    """Endpoint shape plus the one-time ``secret``.

    Used only for the create response and ``rotate_secret`` — the only two
    places the secret is ever revealed.
    """

    secret = serializers.CharField(read_only=True)

    class Meta(WebhookEndpointSerializer.Meta):
        fields = WebhookEndpointSerializer.Meta.fields + ("secret",)


class WebhookDeliverySerializer(serializers.ModelSerializer):
    response_body = serializers.SerializerMethodField()

    class Meta:
        model = WebhookDelivery
        fields = (
            "id",
            "event",
            "task_key",
            "status",
            "attempts",
            "next_attempt_at",
            "last_attempt_at",
            "response_status",
            "response_body",
            "error",
            "created_at",
        )

    def get_response_body(self, obj: WebhookDelivery) -> str:
        return obj.response_body[:DELIVERY_RESPONSE_BODY_PREVIEW_CHARS]
