"""CRM: deals, touchpoints and follow-ups around the people and companies in
``apps.meetings.Entity``.

Conventions that matter (plan + rationale: ``docs/plans/crm.md``):

* **The contact/company record is ``meetings.Entity``**, not a model here. An
  entity is "in the CRM" iff its ``relationship`` is set. There is no second
  contact table — the last CRM died partly because it duplicated people.
* **Facts are derived, not copied.** A contact's timeline is meetings +
  touchpoints + follow-ups unioned at read time (``timeline.py``), and
  ``last_contact_at`` / ``next_follow_up_at`` are query annotations
  (``query.py``), so neither can drift.
* **A follow-up is a normal ``tasks.Task``** in the dedicated CRM project,
  linked here by ``FollowUp``. Board, notifications, ``/focus`` and MCP all
  apply to it unchanged.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction

from apps.tasks.models import TimestampedModel

from .id_generation import generate_deal_key


class StageKind(models.TextChoices):
    """Mirrors ``Column.kind``: code reads the kind, never the stage name."""

    OPEN = "open", "Open"
    WON = "won", "Won"
    LOST = "lost", "Lost"


class Pipeline(TimestampedModel):
    name = models.CharField(max_length=80)
    slug = models.SlugField(max_length=80, unique=True)
    position = models.FloatField(default=0)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return self.name


class Stage(TimestampedModel):
    pipeline = models.ForeignKey(
        Pipeline, on_delete=models.CASCADE, related_name="stages"
    )
    name = models.CharField(max_length=80)
    position = models.FloatField(default=0)
    kind = models.CharField(
        max_length=8, choices=StageKind.choices, default=StageKind.OPEN
    )

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.pipeline.name} / {self.name}"

    @property
    def is_closed(self) -> bool:
        return self.kind != StageKind.OPEN


class Deal(TimestampedModel):
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)
    title = models.CharField(max_length=200)
    pipeline = models.ForeignKey(
        Pipeline, on_delete=models.PROTECT, related_name="deals"
    )
    stage = models.ForeignKey(Stage, on_delete=models.PROTECT, related_name="deals")
    company = models.ForeignKey(
        "meetings.Entity",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="company_deals",
        limit_choices_to={"kind": "company"},
    )
    contacts = models.ManyToManyField(
        "meetings.Entity", blank=True, related_name="contact_deals"
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owned_deals",
    )
    value = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default="QAR")
    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="crm_deals",
        help_text="Which of our businesses this deal is for (Mowafeq, Cyt…).",
    )
    expected_close = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    position = models.FloatField(default=0)
    closed_at = models.DateTimeField(null=True, blank=True)
    lost_reason = models.CharField(max_length=300, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_deals",
    )

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        # Same contract as Task/Meeting: the key is generated once, on first
        # save, inside the transaction that inserts the row.
        if self._state.adding and not self.key:
            with transaction.atomic():
                self.key = generate_deal_key()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class DealCounter(models.Model):
    """Singleton holding the global ``DEAL-<N>`` counter (see ``MeetingCounter``)."""

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    value = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)


class TouchpointKind(models.TextChoices):
    EMAIL = "email", "Email"
    CALL = "call", "Call"
    WHATSAPP = "whatsapp", "WhatsApp"
    CALENDAR = "calendar", "Calendar event"
    NOTE = "note", "Note"
    OTHER = "other", "Other"


class TouchpointSource(models.TextChoices):
    GMAIL = "gmail", "Gmail"
    CALENDAR = "calendar", "Calendar"
    AGENT = "agent", "Agent"
    MANUAL = "manual", "Manual"
    IMPORT = "import", "Import"


class TouchpointDirection(models.TextChoices):
    IN = "in", "Inbound"
    OUT = "out", "Outbound"


class Touchpoint(TimestampedModel):
    """An interaction that isn't a recorded meeting (those are already linked
    to their entities, so the timeline reads them directly).

    ``(source, external_id)`` is the idempotency key for agent pushes — the
    Gmail message id or Calendar event id — same contract as ``Meeting.stem``.
    ``summary`` is a line or two; full email bodies are never stored.
    """

    kind = models.CharField(max_length=16, choices=TouchpointKind.choices)
    direction = models.CharField(
        max_length=3, choices=TouchpointDirection.choices, blank=True, default=""
    )
    occurred_at = models.DateTimeField(db_index=True)
    summary = models.TextField()
    entities = models.ManyToManyField(
        "meetings.Entity", related_name="touchpoints", blank=True
    )
    deal = models.ForeignKey(
        Deal,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="touchpoints",
    )
    source = models.CharField(
        max_length=16, choices=TouchpointSource.choices, default=TouchpointSource.MANUAL
    )
    external_id = models.CharField(max_length=255, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="crm_touchpoints",
    )

    class Meta:
        ordering = ["-occurred_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "external_id"],
                condition=~models.Q(external_id=""),
                name="touchpoint_unique_external_id",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.kind} {self.occurred_at:%Y-%m-%d}: {self.summary[:40]}"


class FollowUp(TimestampedModel):
    """Makes a ``Task`` a CRM follow-up. A join row rather than an FK on
    ``Task`` so the core task model stays free of CRM concerns (same shape as
    ``MeetingTask`` / ``TaskPullRequest``)."""

    task = models.OneToOneField(
        "tasks.Task", on_delete=models.CASCADE, related_name="crm_follow_up"
    )
    entity = models.ForeignKey(
        "meetings.Entity", on_delete=models.CASCADE, related_name="follow_ups"
    )
    deal = models.ForeignKey(
        Deal,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="follow_ups",
    )

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.task_id} → {self.entity_id}"


class CrmSettings(models.Model):
    """Singleton. Holds the CRM project by id so renaming it doesn't break the
    link. The project is created at runtime (``services.crm_project``), not in
    a migration: its default columns come from a ``post_save`` receiver that
    doesn't fire for historical models."""

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)
