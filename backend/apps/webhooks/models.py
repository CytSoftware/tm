"""Outbound webhook data model.

Two models:

    WebhookEndpoint  — a user-owned subscription: "POST signed task events I
                       care about to this URL". Scoped by verb subset and
                       (optionally) one project. ``include_self`` opts into
                       events the owner themself triggered (off by default so
                       an agent isn't notified about its own writes).
                       ``scope`` further widens this: ``"mine"`` (default) is
                       the exact behavior above; ``"all"`` makes it org-wide —
                       every matching task event fires regardless of who
                       acted or who is assigned, and ``include_self`` is
                       ignored (see :mod:`apps.webhooks.dispatch`).
    WebhookDelivery  — one persisted delivery attempt log per (event,
                       endpoint). The UUID primary key doubles as the
                       receiver-side idempotency key (``X-Cyt-Webhook-Id``).

Design notes:

* ``WebhookEndpoint.secret`` is stored in plaintext because it is *used* for
  signing every delivery (HMAC-SHA256, Stripe-style) — it is reveal-once at
  the API layer, never serialized in list/detail responses.
* ``WebhookEndpoint.project`` is CASCADE (not SET_NULL): null means "all
  projects", so a project-scoped endpoint must die with its project rather
  than silently widening to everything.
* ``WEBHOOK_EVENT_TYPES`` (the allowed ``event_types`` values) is the
  in-app ``NotificationVerb`` set plus ``"created"`` — a webhook-only event
  emitted on task creation. It never becomes a ``Notification`` row (see
  :mod:`apps.tasks.notifications`).
* ``WebhookDelivery.payload`` is the full envelope, built eagerly at dispatch
  time — the source task may be deleted immediately after (``task`` FK is
  SET_NULL; ``task_key`` is the denormalized survivor).
* Delivery/retry mechanics live in :mod:`apps.webhooks.delivery`; endpoint
  matching in :mod:`apps.webhooks.dispatch`.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from apps.tasks.models import NotificationVerb

#: Every verb a webhook endpoint may subscribe to: the in-app notification
#: verbs plus ``"created"`` — a webhook-only event (see WebhookScope /
#: apps.tasks.notifications module docstring for why it never becomes a
#: Notification row).
WEBHOOK_EVENT_TYPES = list(NotificationVerb.values) + ["created"]


class WebhookScope(models.TextChoices):
    MINE = "mine", "Mine"
    ALL = "all", "All"


class WebhookEndpoint(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="webhook_endpoints",
    )
    name = models.CharField(max_length=200)
    url = models.URLField(max_length=500)
    secret = models.CharField(
        max_length=64,
        editable=False,
        help_text=(
            "HMAC signing secret (secrets.token_hex(32)). Reveal-once at the "
            "API layer; rotate via the rotate_secret action."
        ),
    )
    event_types = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "Subset of WEBHOOK_EVENT_TYPES this endpoint fires for "
            '(e.g. ["assigned", "moved"]). Empty list = all verbs.'
        ),
    )
    scope = models.CharField(
        max_length=8,
        choices=WebhookScope.choices,
        default=WebhookScope.MINE,
        help_text=(
            "'mine' (default): fires only when the owner is a recipient or "
            "(with include_self) the actor — exact v1 behavior. 'all': "
            "org-wide, fires for every matching task event regardless of who "
            "acted or who is assigned; include_self is ignored."
        ),
    )
    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="webhook_endpoints",
        help_text=(
            "Null = all projects. CASCADE (not SET_NULL) so a project-scoped "
            "endpoint never silently widens to all-projects when its project "
            "is deleted."
        ),
    )
    include_self = models.BooleanField(
        default=False,
        help_text="Also fire for events triggered by the endpoint owner themself.",
    )
    active = models.BooleanField(default=True)
    consecutive_failures = models.PositiveIntegerField(
        default=0,
        help_text=(
            "Terminal delivery failures in a row. Reset to 0 on any success; "
            "the endpoint auto-disables when it crosses "
            "WEBHOOK_DISABLE_AFTER_CONSECUTIVE_FAILURES."
        ),
    )
    disabled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "active"])]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.name} ({self.user_id})"


class WebhookDeliveryStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    SUCCESS = "success", "Success"
    FAILED = "failed", "Failed"


class WebhookDelivery(models.Model):
    """One outbound event delivery, with its full attempt history summary.

    Created ``pending`` by :mod:`apps.webhooks.dispatch`; state transitions
    happen exclusively in :func:`apps.webhooks.delivery.attempt_delivery`
    via tiny autocommit UPDATEs (no long transactions around HTTP).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    endpoint = models.ForeignKey(
        WebhookEndpoint, on_delete=models.CASCADE, related_name="deliveries"
    )
    event = models.CharField(max_length=64, help_text='e.g. "task.assigned"')
    task = models.ForeignKey(
        "tasks.Task",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="webhook_deliveries",
    )
    # Denormalized so the delivery log stays legible after the task is gone.
    task_key = models.CharField(max_length=32, blank=True, default="")
    payload = models.JSONField(
        default=dict, help_text="Full envelope, frozen at dispatch time."
    )
    status = models.CharField(
        max_length=8,
        choices=WebhookDeliveryStatus.choices,
        default=WebhookDeliveryStatus.PENDING,
    )
    attempts = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    response_status = models.PositiveIntegerField(null=True, blank=True)
    response_body = models.TextField(blank=True, default="")
    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "next_attempt_at"]),
            models.Index(fields=["endpoint", "created_at"]),
        ]
        verbose_name_plural = "webhook deliveries"

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.event} -> endpoint {self.endpoint_id} ({self.status})"
