"""Pipelines — long-running processes tracked over time.

Distinct from Tasks: a Task is a unit of work; a Pipeline is a *situation* you
are tracking (e.g. a bank-account application, a vendor onboarding, a partner
deal) that lives for weeks or months and accumulates a chronological event log.

Three models:

    Stage             — kanban columns shared globally (no per-board scoping
                        in v1; we have one global pipelines kanban).
    Pipeline          — the long-lived record. Has a stage + position within
                        that stage (drag-drop), an ad-hoc status, a free-text
                        category and counterparty, and a "next action" with
                        due date.
    PipelineEvent     — append-only timeline entries (note / external / status
                        change / etc.). The Pipeline detail panel renders
                        these in chronological order.

Design notes:

* Pipeline.key is a globally unique human-readable identifier like
  ``PIPE-001``, generated atomically via ``id_generation.py``.
* Pipeline.position is a float used for midpoint insertion within a stage —
  same convention as Task.position.
* No auto-events on stage move. The user explicitly opted out: every event
  is logged by hand so a misclick doesn't pollute the timeline.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction

from .id_generation import generate_pipeline_key


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Stage(TimestampedModel):
    """Kanban column for pipelines.

    Stages are global in v1 — every pipeline lives on the same board. If a
    second board ever appears, add a ``board`` FK and migrate.
    """

    name = models.CharField(max_length=80, unique=True)
    order = models.PositiveSmallIntegerField(unique=True)
    color = models.CharField(
        max_length=9,
        default="#6366f1",
        help_text="CSS hex color used to badge the stage in the UI.",
    )
    is_terminal = models.BooleanField(
        default=False,
        help_text="Marks an end-state stage (Won / Lost). UI may grey out.",
    )

    class Meta:
        ordering = ["order"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return self.name


class Pipeline(TimestampedModel):
    # ``key`` is blank at construction time; filled in by save() below.
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)
    title = models.CharField(max_length=300)
    description = models.TextField(
        blank=True,
        default="",
        help_text="Free-text background. Day-to-day detail belongs in events.",
    )

    counterparty = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text="External party we're dealing with (bank name, vendor, etc.).",
    )

    stage = models.ForeignKey(
        Stage,
        on_delete=models.PROTECT,
        related_name="pipelines",
    )
    position = models.FloatField(
        default=1000.0,
        help_text="Sort order within a stage. Midpoint insertion strategy.",
    )

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owned_pipelines",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_pipelines",
    )

    class Meta:
        ordering = ["stage_id", "position", "id"]
        indexes = [
            models.Index(fields=["stage", "position"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        if self._state.adding and not self.key:
            with transaction.atomic():
                self.key = generate_pipeline_key()
                self._assign_tail_position()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)

    def _assign_tail_position(self):
        if not self.stage_id:
            return
        tail = (
            Pipeline.objects.filter(stage_id=self.stage_id)
            .aggregate(m=models.Max("position"))["m"]
        )
        if tail is not None:
            self.position = tail + 1000.0


class PipelineEvent(models.Model):
    """Append-only timeline entry for a pipeline. Plain text body + author."""

    pipeline = models.ForeignKey(
        Pipeline, on_delete=models.CASCADE, related_name="events"
    )
    body = models.TextField(blank=True, default="")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="pipeline_events",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["pipeline_id", "created_at", "id"]
        indexes = [
            models.Index(fields=["pipeline", "created_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.pipeline_id} @ {self.created_at.isoformat()}"


class PipelineCounter(models.Model):
    """Singleton holding the global PIPE-<N> counter.

    A separate row (rather than packing the counter into Stage or another
    table) keeps the locking surface tiny — every create takes a row lock on
    this single ``id=1`` row and nothing else.
    """

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    value = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)


# ---------------------------------------------------------------------------
# Default stages for the global pipelines board.
# ---------------------------------------------------------------------------
# Seeded by a data migration on first run; safe to extend later.

DEFAULT_STAGES = [
    {"name": "New", "order": 0, "color": "#94a3b8", "is_terminal": False},
    {"name": "In Progress", "order": 1, "color": "#3b82f6", "is_terminal": False},
    {"name": "Awaiting Response", "order": 2, "color": "#f59e0b", "is_terminal": False},
    {"name": "Action Required", "order": 3, "color": "#ef4444", "is_terminal": False},
    {"name": "Won", "order": 4, "color": "#10b981", "is_terminal": True},
    {"name": "Lost", "order": 5, "color": "#6b7280", "is_terminal": True},
]
