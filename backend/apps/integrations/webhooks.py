"""GitHub webhook entry point.

Public surface:

* :func:`verify_signature` — HMAC-SHA256 check of the webhook body.
* :func:`dispatch_event` — route a parsed event to the right service fn.
* :func:`github_webhook_view` — plain Django view mounted at
  ``/api/integrations/github/webhook/``.

**Why a plain Django view, not DRF**: HMAC verification runs over the raw
body, and DRF's ``JSONParser`` consumes the body stream during
``request.data`` access. Using a plain view sidesteps that interaction.
The GitHub App **must** be configured to send webhooks as
``Content-Type: application/json``, not form-encoded.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from . import services
from .event_ingest import record_event
from .models import EventSource

logger = logging.getLogger(__name__)

_DELIVERY_CACHE_PREFIX = "github:delivery:"
_DELIVERY_TTL_SECONDS = 24 * 60 * 60
_MAX_EVENT_BODY_BYTES = 1_000_000


def verify_signature(body: bytes, header: str | None) -> bool:
    """Validate a GitHub ``X-Hub-Signature-256`` header against ``body``.

    Returns ``False`` when the secret is unset — a missing secret means the
    webhook endpoint is closed, not open.
    """
    secret = getattr(settings, "GITHUB_WEBHOOK_SECRET", "") or ""
    if not secret:
        return False
    if not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header)


def _already_processed(delivery_id: str | None) -> bool:
    """Check and record a delivery UUID for idempotency.

    Uses the default cache backend. Phase-1 ``locmem`` is fine for a single
    Daphne process; the worst failure mode on restart is a duplicate
    ``TaskPullRequest`` upsert, which is a no-op, plus a harmless duplicate
    broadcast. P3 swaps this for a durable DB table.
    """
    if not delivery_id:
        return False
    key = f"{_DELIVERY_CACHE_PREFIX}{delivery_id}"
    if cache.get(key) is not None:
        return True
    cache.set(key, 1, timeout=_DELIVERY_TTL_SECONDS)
    return False


def dispatch_event(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Route a parsed GitHub event to the corresponding service function."""
    if event_type == "ping":
        return {"ok": True, "pong": True}
    if event_type == "pull_request":
        action = str(payload.get("action") or "")
        result = services.apply_pull_request_event(payload, action=action)
        return {
            "ok": True,
            "projects_matched": result.projects_matched,
            "tasks_linked": result.tasks_linked,
            "tasks_unlinked": result.tasks_unlinked,
            "tasks_moved": result.tasks_moved,
        }
    if event_type == "pull_request_review":
        review_result = services.apply_pull_request_review_event(payload)
        return {
            "ok": True,
            "tasks_matched": review_result.tasks_matched,
            "tasks_moved": review_result.tasks_moved,
        }
    return {"ok": True, "ignored": event_type}


def _header(request: HttpRequest, *names: str) -> str:
    for name in names:
        value = request.headers.get(name)
        if value:
            return value
        meta_key = "HTTP_" + name.upper().replace("-", "_")
        value = request.META.get(meta_key)
        if value:
            return value
    return ""


@csrf_exempt
@require_POST
def github_webhook_view(request: HttpRequest) -> JsonResponse:
    body = request.body or b""

    signature = _header(request, "X-Hub-Signature-256")
    if not verify_signature(body, signature):
        logger.warning("github webhook signature rejected")
        return JsonResponse({"detail": "forbidden"}, status=403)

    delivery = _header(request, "X-GitHub-Delivery") or None
    if _already_processed(delivery):
        logger.info("github webhook duplicate delivery %s ignored", delivery)
        return JsonResponse({"ok": True, "duplicate": True})

    event_type = _header(request, "X-GitHub-Event").strip()
    if not event_type:
        return JsonResponse({"detail": "missing event header"}, status=400)

    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError) as e:
        logger.warning("github webhook invalid json: %s", e)
        return JsonResponse({"detail": "invalid json"}, status=400)
    if not isinstance(payload, dict):
        return JsonResponse({"detail": "invalid payload"}, status=400)

    try:
        result = dispatch_event(event_type, payload)
    except Exception:  # pragma: no cover - defensive
        logger.exception("github webhook dispatch failed")
        return JsonResponse({"detail": "internal error"}, status=500)

    return JsonResponse(result)


@csrf_exempt
@require_POST
def event_source_ingest_view(request: HttpRequest, token) -> JsonResponse:
    """Accept JSON for an active source identified by its unguessable URL."""
    content_length = request.META.get("CONTENT_LENGTH")
    try:
        if content_length and int(content_length) > _MAX_EVENT_BODY_BYTES:
            return JsonResponse({"detail": "payload too large"}, status=413)
    except (TypeError, ValueError):
        return JsonResponse({"detail": "invalid content length"}, status=400)

    try:
        source = EventSource.objects.get(token=token, active=True)
    except EventSource.DoesNotExist:
        return JsonResponse({"detail": "not found"}, status=404)

    body = request.body or b""
    if len(body) > _MAX_EVENT_BODY_BYTES:
        return JsonResponse({"detail": "payload too large"}, status=413)
    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"detail": "invalid json"}, status=400)
    if not isinstance(payload, dict):
        return JsonResponse({"detail": "payload must be a JSON object"}, status=400)

    event, created = record_event(source, payload, request.headers)
    return JsonResponse(
        {"ok": True, "created": created, "event_id": event.pk},
        status=201 if created else 200,
    )
