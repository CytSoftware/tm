"""Webhook-retry middleware.

``LazyWebhookRetryMiddleware`` mirrors the cache-gated shape of
``apps.tasks.middleware.LazyRecurringMiddleware`` — a safety net that runs the
retry pass when the primary trigger (a cron/systemd timer running
``python manage.py deliver_webhooks``) isn't configured — **with one
deliberate structural deviation**: the pass is handed to a daemon thread
instead of running inline. The recurring generator is fast, pure-ORM work;
webhook retries perform outbound HTTP against arbitrary user-supplied URLs
(up to 100 deliveries × ``WEBHOOK_DELIVERY_TIMEOUT_SECONDS`` each) and must
never add that latency to a real user request.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from django.conf import settings
from django.core.cache import cache
from django.http import HttpRequest, HttpResponse
from django.utils import timezone

logger = logging.getLogger(__name__)

_CACHE_KEY = "apps.webhooks.retry.last_scan_at"


class LazyWebhookRetryMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        self.interval = getattr(settings, "WEBHOOK_LAZY_SCAN_INTERVAL_SECONDS", 300)

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self._maybe_scan()
        return self.get_response(request)

    def _maybe_scan(self) -> None:
        now = timezone.now()
        last = cache.get(_CACHE_KEY)
        if last and (now - last).total_seconds() < self.interval:
            return

        # Record "scanned" before running so a slow pass doesn't spawn
        # concurrent passes on every request.
        cache.set(_CACHE_KEY, now, timeout=self.interval * 2)

        def _run() -> None:
            try:
                # Local import: avoid pulling ORM code into module import time.
                from .delivery import process_due_deliveries

                attempted = process_due_deliveries(now=now)
                if attempted:
                    logger.info(
                        "LazyWebhookRetryMiddleware attempted %d due webhook "
                        "deliver(y/ies)",
                        attempted,
                    )
            except Exception:  # pragma: no cover - defensive
                # Don't let a retry-pass bug break anything; clear the cache
                # so the next request retries.
                logger.exception("LazyWebhookRetryMiddleware scan failed")
                cache.delete(_CACHE_KEY)

        threading.Thread(target=_run, daemon=True).start()
