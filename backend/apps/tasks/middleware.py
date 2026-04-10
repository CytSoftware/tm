"""Task-tracker middleware.

``LazyRecurringMiddleware`` is a safety net: on each request, if the last
recurring-task scan was longer than ``RECURRING_LAZY_SCAN_INTERVAL_SECONDS``
ago, it triggers the generator. The primary trigger is still a system timer
running ``python manage.py generate_recurring_tasks``; this middleware only
guarantees correctness when that timer isn't configured.

The scan is gated by a cache entry so the hot HTTP path stays cheap. On a
quiet system the first request after the interval window pays a single scan,
then the cache absorbs subsequent requests until the window reopens.
"""

from __future__ import annotations

import logging
from typing import Callable

from django.conf import settings
from django.core.cache import cache
from django.http import HttpRequest, HttpResponse
from django.utils import timezone

logger = logging.getLogger(__name__)

_CACHE_KEY = "apps.tasks.recurring.last_scan_at"


class LazyRecurringMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        self.interval = getattr(
            settings, "RECURRING_LAZY_SCAN_INTERVAL_SECONDS", 600
        )

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self._maybe_scan()
        return self.get_response(request)

    def _maybe_scan(self) -> None:
        now = timezone.now()
        last = cache.get(_CACHE_KEY)
        if last and (now - last).total_seconds() < self.interval:
            return

        # Record "scanned" before running so a slow scan doesn't spawn
        # concurrent scans on every request.
        cache.set(_CACHE_KEY, now, timeout=self.interval * 2)

        try:
            # Local import: avoid pulling ORM code into module import time.
            from .recurring import generate_due_instances

            created = generate_due_instances(now=now)
            if created:
                logger.info(
                    "LazyRecurringMiddleware generated %d recurring task(s)",
                    len(created),
                )
        except Exception:  # pragma: no cover - defensive
            # Don't let a recurring-generator bug break unrelated requests.
            logger.exception("LazyRecurringMiddleware scan failed")
            # Clear the cache so the next request retries.
            cache.delete(_CACHE_KEY)
