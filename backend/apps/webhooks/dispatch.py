"""Endpoint matching + delivery enqueueing for task events.

Single entry point, :func:`dispatch_task_webhooks`, called from
``apps.tasks.notifications._notify_task_event`` — one hook covers every task
write path (DRF views, MCP tools, recurring generator). Like
``broadcast_task_event`` and ``notify_task_event``, it must never raise into
the caller.

Flow:

1. Interested user ids = the (deduped, actor-excluded) notification
   recipients, plus the actor themself for ``include_self`` endpoints. This
   set may be empty (system events, or a purely-unassigned task update) —
   that's fine, ``scope="all"`` endpoints don't need it.
2. Query active endpoints that are EITHER ``scope="all"`` (org-wide) OR
   owned by one of the interested users. Filter by verb ∈ ``event_types``
   (empty list = all) and project scope (null = all projects; inbox tasks —
   ``task.project_id is None`` — only match unscoped endpoints) — both apply
   to either scope.
3. Per-endpoint ownership matching: ``scope="all"`` endpoints match
   unconditionally past the verb/project filters (``include_self`` is
   ignored — org-wide means org-wide). ``scope="mine"`` endpoints keep the
   exact v1 rule: the owner must be a recipient, or the actor themself with
   ``include_self=True``.
4. Build the payload envelope *eagerly* (the task may be about to be
   deleted), ``bulk_create`` pending :class:`WebhookDelivery` rows, and — once
   the surrounding transaction commits (``transaction.on_commit``) — hand the
   batch to ONE daemon thread that runs
   :func:`apps.webhooks.delivery.attempt_delivery` per row.
"""

from __future__ import annotations

import logging
import threading
import uuid
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .delivery import attempt_delivery, build_envelope
from .models import (
    WebhookDelivery,
    WebhookDeliveryStatus,
    WebhookEndpoint,
    WebhookScope,
)

logger = logging.getLogger(__name__)


def dispatch_task_webhooks(
    *,
    task,
    actor,
    verb: str,
    recipients: Iterable[Any],
    extra: dict[str, Any] | None = None,
) -> None:
    """Enqueue webhook deliveries for a task event. Never raises.

    ``recipients`` is the deduped notification recipient list (the actor is
    already excluded from it — actor-owned endpoints are matched separately
    via ``include_self``). ``actor`` may be ``None`` for system events.
    ``task`` must still be a live in-memory instance (``verb == "deleted"``
    fires pre-delete).
    """
    try:
        _dispatch_task_webhooks(task, actor, verb, list(recipients), extra or {})
    except Exception:  # pragma: no cover - defensive, mirrors notify_task_event
        logger.exception(
            "dispatch_task_webhooks failed (verb=%s task=%s)",
            verb,
            getattr(task, "key", None),
        )


def _dispatch_task_webhooks(
    task, actor, verb: str, recipients: list, extra: dict[str, Any]
) -> None:
    recipient_ids = {u.id for u in recipients if u is not None}
    actor_id = getattr(actor, "id", None)

    interested_ids = set(recipient_ids)
    if actor_id is not None:
        interested_ids.add(actor_id)

    # No early return on empty interested_ids: scope="all" endpoints must
    # still match system events (actor=None) and unassigned-task activity
    # (recipients=[]) — e.g. the recurring generator's "created" event.
    endpoints = list(
        WebhookEndpoint.objects.filter(active=True)
        .filter(Q(scope=WebhookScope.ALL) | Q(user_id__in=interested_ids))
        .select_related("user")
    )
    if not endpoints:
        return

    task_project_id = getattr(task, "project_id", None)
    matched: list[WebhookEndpoint] = []
    for ep in endpoints:
        if ep.event_types and verb not in ep.event_types:
            continue
        if ep.project_id is not None and ep.project_id != task_project_id:
            continue
        if ep.scope == WebhookScope.ALL:
            # Org-wide: matches unconditionally past verb/project filters.
            # include_self is meaningless here — everyone's actions qualify.
            matched.append(ep)
            continue
        # scope="mine": the owner must be a recipient, or the actor
        # themself with include_self=True. (An actor who is also a genuine
        # recipient never reaches the include_self branch — the
        # notifications layer excludes them from `recipients` by design.)
        if ep.user_id in recipient_ids or (ep.include_self and ep.user_id == actor_id):
            matched.append(ep)

    if not matched:
        return

    now = timezone.now()
    to_create: list[WebhookDelivery] = []
    for ep in matched:
        delivery_id = uuid.uuid4()
        envelope = build_envelope(
            delivery_id=delivery_id,
            event=verb,
            actor=actor,
            recipient=ep.user,
            recipients=recipients,
            task=task,
            extra=extra,
            created_at=now,
        )
        to_create.append(
            WebhookDelivery(
                id=delivery_id,
                endpoint=ep,
                event=verb,
                task=task if getattr(task, "pk", None) else None,
                task_key=getattr(task, "key", "") or "",
                payload=envelope,
                status=WebhookDeliveryStatus.PENDING,
                next_attempt_at=now,
            )
        )

    created = WebhookDelivery.objects.bulk_create(to_create)
    delivery_ids = [d.pk for d in created]

    def _run() -> None:
        for delivery_id in delivery_ids:
            attempt_delivery(delivery_id)

    # Defer the first-attempt thread until the surrounding transaction commits.
    # Task writes from the MCP tools and the recurring generator run inside an
    # open ``transaction.atomic`` block, so the just-``bulk_create``d rows are
    # not yet visible on the daemon thread's separate DB connection — it would
    # ``DoesNotExist`` and drop the immediate attempt, delaying delivery until
    # the retry pass. ``on_commit`` runs the callback synchronously when there
    # is no active transaction (the DRF write paths), so those stay immediate.
    transaction.on_commit(
        lambda: threading.Thread(target=_run, daemon=True).start()
    )


def enqueue_test_delivery(endpoint: WebhookEndpoint) -> WebhookDelivery:
    """Create a pending ``webhook.test`` delivery for ``endpoint``.

    Used by the DRF ``test`` action (which then calls ``attempt_delivery``
    synchronously — an explicit, user-initiated, low-frequency action where
    immediate feedback beats the never-block-a-request rule).
    """
    delivery_id = uuid.uuid4()
    now = timezone.now()
    envelope = build_envelope(
        delivery_id=delivery_id,
        event="webhook.test",
        actor=endpoint.user,
        recipient=endpoint.user,
        recipients=[],
        task=None,
        extra={"message": "This is a test delivery from Cyt."},
        created_at=now,
    )
    return WebhookDelivery.objects.create(
        id=delivery_id,
        endpoint=endpoint,
        event="webhook.test",
        task=None,
        task_key="",
        payload=envelope,
        status=WebhookDeliveryStatus.PENDING,
        next_attempt_at=now,
    )
