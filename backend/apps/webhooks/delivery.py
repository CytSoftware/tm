"""Webhook payload envelopes, signing, and the delivery/retry worker.

Delivery contract (mirrors the style of :mod:`apps.tasks.emails` — outbound
HTTP off the request path — plus :mod:`apps.tasks.recurring` — a claim pass
that is safe to run concurrently):

* :func:`build_envelope` is pure — no DB writes — and is called *eagerly* at
  dispatch time because the source task may be deleted right after (the
  ``deleted`` verb fires pre-delete).
* The wire body is a **deterministic** serialization of the stored payload
  (``json.dumps(..., separators=(",", ":"), sort_keys=True)``), so the raw
  bytes never need to be stored: receiver-side verification re-derives them
  from the JSON.
* Signing is Stripe-style HMAC-SHA256 over ``f"{timestamp}." + body`` —
  the verify half mirrors :func:`apps.integrations.webhooks.verify_signature`.
* :func:`attempt_delivery` runs in a daemon thread (first attempt) or
  synchronously (retry pass / the DRF ``test`` action). Unlike ``emails.py``
  the thread *must* use the ORM to record results, so it calls
  ``close_old_connections()`` on entry and ``connection.close()`` in a
  ``finally``. All writes are tiny autocommit UPDATEs — never a
  ``transaction.atomic`` around the HTTP call — to respect SQLite locking.
* :func:`process_due_deliveries` is the retry pass: an atomic
  ``select_for_update`` claim over due pending rows (batch 100) that pushes
  ``next_attempt_at`` forward *inside* the transaction so a concurrent runner
  (cron process + lazy middleware — the locmem cache is per-process, so both
  WILL run) cannot double-send; the POSTs happen outside the transaction.

Like ``broadcast_task_event``, neither entry point ever raises into callers.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import close_old_connections, connection, transaction
from django.db.models import F
from django.utils import timezone

from .models import WebhookDelivery, WebhookDeliveryStatus, WebhookEndpoint

logger = logging.getLogger(__name__)

#: Stored response bodies / error strings are truncated to this many chars —
#: the delivery log is for debugging, not archiving receiver output.
RESPONSE_BODY_MAX_CHARS = 2000

#: Batch size for one retry pass.
RETRY_BATCH_SIZE = 100


# ---------------------------------------------------------------------------
# Envelope + signing
# ---------------------------------------------------------------------------


def build_envelope(
    *,
    delivery_id: UUID,
    event: str,
    actor,
    recipient,
    task,
    extra: dict[str, Any] | None = None,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    """Build the full webhook payload envelope. Pure — no DB writes.

    ``actor`` may be ``None`` (system events, e.g. the recurring generator).
    ``task`` may be ``None`` (synthetic ``webhook.test`` deliveries), and a
    real task's ``project``/``column`` may be ``None`` (inbox tasks) — all
    of those render as JSON nulls.
    """
    frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000").rstrip("/")

    task_dict = None
    if task is not None:
        task_dict = {
            "key": task.key,
            "title": task.title,
            "project_id": task.project_id,
            "project_name": task.project.name if task.project_id else None,
            "column": task.column.name if task.column_id else None,
            "priority": task.priority,
            "due_at": task.due_at.isoformat() if task.due_at else None,
            # No per-task deep link exists yet; the board URL matches what
            # assignment emails send (apps/tasks/emails.py).
            "url": f"{frontend_url}/board",
        }

    return {
        "id": str(delivery_id),
        "event": event,
        "created_at": (created_at or timezone.now()).isoformat(),
        "actor": (
            {"id": actor.id, "username": actor.username} if actor is not None else None
        ),
        "recipient": {"id": recipient.id, "username": recipient.username},
        "task": task_dict,
        "data": extra or {},
    }


def serialize_body(payload: dict[str, Any]) -> bytes:
    """Deterministic JSON bytes for signing + POSTing.

    Key order and separators are pinned so the receiver can re-serialize the
    parsed JSON and get byte-identical input for HMAC verification.
    """
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()


def sign_payload(secret: str, body: bytes, timestamp: int) -> str:
    """Stripe-style signature: ``sha256=HMAC(secret, "{ts}." + body)``.

    The timestamp prefix binds the signature to a moment in time so receivers
    can reject stale/replayed deliveries. The verify half mirrors
    :func:`apps.integrations.webhooks.verify_signature` (``compare_digest``
    against the same construction).
    """
    mac = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.".encode() + body, hashlib.sha256
    )
    return "sha256=" + mac.hexdigest()


# ---------------------------------------------------------------------------
# Single-delivery worker
# ---------------------------------------------------------------------------


def attempt_delivery(delivery_id: UUID | str) -> None:
    """POST one delivery and record the outcome. Never raises.

    Runs in a daemon thread (dispatch-time first attempt), synchronously in
    the retry pass, or inline in the DRF ``test`` action. Requires ORM access
    to record results, hence the connection hygiene below.
    """
    close_old_connections()
    try:
        _attempt_delivery(delivery_id)
    except Exception:  # pragma: no cover - defensive, fire-and-forget contract
        logger.exception("attempt_delivery(%s) raised", delivery_id)
    finally:
        connection.close()


def _attempt_delivery(delivery_id: UUID | str) -> None:
    try:
        delivery = WebhookDelivery.objects.select_related("endpoint").get(
            pk=delivery_id
        )
    except WebhookDelivery.DoesNotExist:
        logger.warning("attempt_delivery: delivery %s no longer exists", delivery_id)
        return

    if delivery.status != WebhookDeliveryStatus.PENDING:
        return

    endpoint = delivery.endpoint
    if not endpoint.active:
        # Endpoint was disabled between enqueue and this attempt. Leave the
        # row pending and untouched — no send, no reschedule — so the normal
        # retry pass picks it back up if the endpoint is re-enabled. (Rows on
        # endpoints that stay disabled just sit pending; they're skipped here
        # every time and cost one cheap SELECT per retry pass.)
        logger.info(
            "attempt_delivery: endpoint %s inactive, skipping delivery %s",
            endpoint.id,
            delivery.id,
        )
        return

    body = serialize_body(delivery.payload)
    ts = int(time.time())
    req = urllib.request.Request(
        endpoint.url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Cyt-Webhook-Id": str(delivery.id),
            "X-Cyt-Timestamp": str(ts),
            "X-Cyt-Signature": sign_payload(endpoint.secret, body, ts),
            "X-Cyt-Event": delivery.event,
        },
        method="POST",
    )

    timeout = getattr(settings, "WEBHOOK_DELIVERY_TIMEOUT_SECONDS", 10)
    now = timezone.now()
    attempts = delivery.attempts + 1

    response_status: int | None = None
    response_body = ""
    error = ""
    success = False

    try:
        # TODO(SSRF): user-supplied URLs are POSTed from the server. Fine for
        # a trusted single-team instance; blocklist private ranges if the
        # user base ever widens.
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            response_status = resp.status
            response_body = resp.read(RESPONSE_BODY_MAX_CHARS + 1).decode(
                "utf-8", errors="replace"
            )[:RESPONSE_BODY_MAX_CHARS]
        success = 200 <= (response_status or 0) < 300
        if not success:  # pragma: no cover - urlopen raises on non-2xx
            error = f"non-2xx response: {response_status}"
    except urllib.error.HTTPError as e:
        response_status = e.code
        try:
            response_body = e.read(RESPONSE_BODY_MAX_CHARS + 1).decode(
                "utf-8", errors="replace"
            )[:RESPONSE_BODY_MAX_CHARS]
        except Exception:
            response_body = ""
        error = f"HTTP {e.code}"
    except urllib.error.URLError as e:
        error = str(e.reason)[:RESPONSE_BODY_MAX_CHARS]
    except Exception as e:  # pragma: no cover - defensive
        error = f"{type(e).__name__}: {e}"[:RESPONSE_BODY_MAX_CHARS]

    if success:
        WebhookDelivery.objects.filter(pk=delivery.pk).update(
            status=WebhookDeliveryStatus.SUCCESS,
            attempts=attempts,
            last_attempt_at=now,
            next_attempt_at=None,
            response_status=response_status,
            response_body=response_body,
            error="",
        )
        WebhookEndpoint.objects.filter(pk=endpoint.pk).update(consecutive_failures=0)
        return

    schedule = getattr(
        settings, "WEBHOOK_RETRY_SCHEDULE_SECONDS", [60, 300, 1800, 7200, 43200]
    )
    if attempts <= len(schedule):
        # Still retryable: schedule the next attempt on the backoff grid.
        WebhookDelivery.objects.filter(pk=delivery.pk).update(
            status=WebhookDeliveryStatus.PENDING,
            attempts=attempts,
            last_attempt_at=now,
            next_attempt_at=now + timedelta(seconds=schedule[attempts - 1]),
            response_status=response_status,
            response_body=response_body,
            error=error,
        )
        return

    # Terminal failure — out of retries.
    WebhookDelivery.objects.filter(pk=delivery.pk).update(
        status=WebhookDeliveryStatus.FAILED,
        attempts=attempts,
        last_attempt_at=now,
        next_attempt_at=None,
        response_status=response_status,
        response_body=response_body,
        error=error,
    )
    WebhookEndpoint.objects.filter(pk=endpoint.pk).update(
        consecutive_failures=F("consecutive_failures") + 1
    )
    threshold = getattr(settings, "WEBHOOK_DISABLE_AFTER_CONSECUTIVE_FAILURES", 20)
    failures = (
        WebhookEndpoint.objects.filter(pk=endpoint.pk)
        .values_list("consecutive_failures", flat=True)
        .first()
    )
    if failures is not None and failures >= threshold:
        WebhookEndpoint.objects.filter(pk=endpoint.pk, active=True).update(
            active=False, disabled_at=now
        )
        logger.warning(
            "webhook endpoint %s auto-disabled after %d consecutive failures",
            endpoint.pk,
            failures,
        )


# ---------------------------------------------------------------------------
# Retry pass
# ---------------------------------------------------------------------------


def process_due_deliveries(now: datetime | None = None) -> int:
    """Attempt every pending delivery whose ``next_attempt_at`` has passed.

    Claims up to :data:`RETRY_BATCH_SIZE` rows inside a
    ``transaction.atomic()`` + ``select_for_update()`` block, pushing
    ``next_attempt_at`` forward *inside* the transaction so a concurrent
    runner can't claim the same rows, then POSTs outside the transaction.

    Returns the number of deliveries attempted. Never raises — safe to call
    from the management command and the lazy middleware concurrently.
    """
    now = now or timezone.now()

    try:
        with transaction.atomic():
            due = list(
                WebhookDelivery.objects.select_for_update()
                .filter(
                    status=WebhookDeliveryStatus.PENDING,
                    next_attempt_at__lte=now,
                )
                .order_by("next_attempt_at")[:RETRY_BATCH_SIZE]
            )
            claimed_ids = [d.pk for d in due]
            if claimed_ids:
                # Anti-double-claim fence: a concurrent runner filtering on
                # next_attempt_at <= its own "now" won't see these rows again.
                # attempt_delivery overwrites this with the real backoff value
                # (or clears it) once the POST outcome is known.
                WebhookDelivery.objects.filter(pk__in=claimed_ids).update(
                    next_attempt_at=now + timedelta(seconds=60)
                )
    except Exception:  # pragma: no cover - defensive
        logger.exception("process_due_deliveries claim pass failed")
        return 0

    for delivery_id in claimed_ids:
        attempt_delivery(delivery_id)

    return len(claimed_ids)
