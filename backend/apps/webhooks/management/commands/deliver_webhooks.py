"""Management command: retry any due webhook deliveries.

Intended to be invoked on a cadence by a system timer:

    # systemd user timer (preferred)
    # [Timer]
    # OnUnitActiveSec=5min

    # cron alternative
    # */5 * * * * cd /abs/path/backend && .venv/bin/python manage.py deliver_webhooks

Running this more often than necessary is wasteful but harmless — the claim
pass is idempotent (``select_for_update`` + ``next_attempt_at`` push-forward),
so concurrent runners never double-send.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.webhooks.delivery import process_due_deliveries


class Command(BaseCommand):
    help = "Retry any pending webhook deliveries whose next_attempt_at has passed."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--now",
            type=str,
            default=None,
            help=(
                "Pretend it's this ISO-8601 timestamp. "
                "Useful for testing backoff traversal without touching the system clock."
            ),
        )

    def handle(self, *args, **options):
        now_arg = options.get("now")
        if now_arg:
            now = timezone.datetime.fromisoformat(now_arg)
            if timezone.is_naive(now):
                now = timezone.make_aware(now, timezone.get_current_timezone())
        else:
            now = timezone.now()

        attempted = process_due_deliveries(now=now)
        self.stdout.write(
            self.style.SUCCESS(
                f"Attempted {attempted} due webhook deliver(y/ies) at {now.isoformat()}."
            )
        )
