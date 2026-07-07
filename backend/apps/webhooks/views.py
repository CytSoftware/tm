"""DRF views for managing the calling user's webhook endpoints.

Strictly scoped to ``request.user`` (NotificationViewSet-style): list,
retrieve, and every extra action resolve through ``get_queryset`` below, so
another user's endpoints 404. Session auth + IsAuthenticated come from the
project-wide DRF defaults in ``core/settings.py``.
"""

from __future__ import annotations

import secrets

from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .delivery import attempt_delivery
from .dispatch import enqueue_test_delivery
from .models import WebhookEndpoint
from .serializers import (
    WebhookDeliverySerializer,
    WebhookEndpointCreatedSerializer,
    WebhookEndpointSerializer,
)


class WebhookEndpointViewSet(viewsets.ModelViewSet):
    serializer_class = WebhookEndpointSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return WebhookEndpoint.objects.none()
        return WebhookEndpoint.objects.filter(user=self.request.user).select_related(
            "project"
        )

    def get_serializer_class(self):
        # The create response is the one-time secret reveal.
        if self.action == "create":
            return WebhookEndpointCreatedSerializer
        return WebhookEndpointSerializer

    def perform_create(self, serializer):
        serializer.save(user=self.request.user, secret=secrets.token_hex(32))

    @action(detail=True, methods=["post"], url_path="rotate_secret")
    def rotate_secret(self, request, pk=None):
        """Generate a fresh signing secret and reveal it (one time)."""
        endpoint = self.get_object()
        endpoint.secret = secrets.token_hex(32)
        endpoint.save(update_fields=["secret", "updated_at"])
        return Response(WebhookEndpointCreatedSerializer(endpoint).data)

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Enqueue a ``webhook.test`` delivery and attempt it immediately.

        Deliberately synchronous (the one exception to the "outbound webhook
        HTTP never runs inline on a request" rule): this is an explicit,
        user-initiated, low-frequency action where immediate feedback —
        status + response code in this very response — is the whole point.
        """
        endpoint = self.get_object()
        delivery = enqueue_test_delivery(endpoint)
        attempt_delivery(delivery.pk)
        delivery.refresh_from_db()
        return Response(WebhookDeliverySerializer(delivery).data)

    @action(detail=True, methods=["get"])
    def deliveries(self, request, pk=None):
        """The endpoint's 50 most recent deliveries, newest first."""
        endpoint = self.get_object()
        qs = endpoint.deliveries.all()[:50]  # Meta.ordering = -created_at
        return Response(WebhookDeliverySerializer(qs, many=True).data)
