"""Management command: generate any due recurring tasks.

Intended to be invoked on a cadence by a system timer:

    # systemd user timer (preferred)
    # [Timer]
    # OnUnitActiveSec=5min

    # cron alternative
    # */5 * * * * cd /abs/path/backend && .venv/bin/python manage.py generate_recurring_tasks

Running this more often than the finest RRULE granularity is wasteful but
harmless — the generator is idempotent.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.tasks.recurring import generate_due_instances


class Command(BaseCommand):
    help = "Generate any recurring tasks whose next_run_at has passed."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--now",
            type=str,
            default=None,
            help=(
                "Pretend it's this ISO-8601 timestamp. "
                "Useful for testing rrule traversal without touching the system clock."
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

        created = generate_due_instances(now=now)
        self.stdout.write(
            self.style.SUCCESS(
                f"Generated {len(created)} recurring task(s) at {now.isoformat()}."
            )
        )
        for task in created:
            self.stdout.write(f"  {task.key}: {task.title}")
