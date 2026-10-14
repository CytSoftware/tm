"""CRM: leads, and the updates that form each lead's thread.

Conventions that matter (plan + rationale: ``docs/plans/crm.md``):

* **People and companies are ``meetings.Entity``**, not a model here — one
  table, shared with meetings (aliases, merge and ``wiki_slug`` already work).
  There is no "in the CRM" flag: a company is in it once it has a lead, a
  person once an update tags them or their company has a lead.
* **A lead is one opportunity** (ECG — Mowafeq pilot): a company, one of our
  projects, a stage on a fixed board.
* **An update is one thing that happened** — a call, a message, a meeting — on
  a lead's thread, tagging the people it was with on their side (``people``)
  and ours (``users``). A recorded meeting is linked, not copied.
* **What they need next is a task** filed by the update that raised it
  (``Update.task``), in the lead's project — so the board, ``/focus`` and
  notifications apply, and the lead reaches it through the update. A lead's
  next step is its soonest open one.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction

from apps.tasks.models import TimestampedModel

from .id_generation import generate_lead_key


class LeadStage(models.TextChoices):
    """The board's columns, in order. Code reads ``CLOSED_STAGES``, never names."""

    NEW = "new", "New"
    DISCOVERY = "discovery", "Discovery"
    DEMO = "demo", "Demo"
    PILOT = "pilot", "Pilot"
    PROPOSAL = "proposal", "Proposal"
    WON = "won", "Won"
    LOST = "lost", "Lost"


CLOSED_STAGES = (LeadStage.WON, LeadStage.LOST)


class Lead(TimestampedModel):
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)
    title = models.CharField(max_length=200)
    company = models.ForeignKey(
        "meetings.Entity",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="leads",
        limit_choices_to={"kind": "company"},
    )
    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="crm_leads",
        help_text="Which of our businesses this lead is for (Mowafeq, Cyt…).",
    )
    stage = models.CharField(
        max_length=16, choices=LeadStage.choices, default=LeadStage.NEW, db_index=True
    )
    notes = models.TextField(blank=True, default="", help_text="Standing context; what happened goes in updates.")
    lost_reason = models.CharField(max_length=300, blank=True, default="")
    position = models.FloatField(default=0)
    closed_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_leads",
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
                self.key = generate_lead_key()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class LeadCounter(models.Model):
    """Singleton holding the global ``LEAD-<N>`` counter (see ``MeetingCounter``)."""

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    value = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)


class UpdateKind(models.TextChoices):
    NOTE = "note", "Note"
    MESSAGE = "message", "Message"
    CALL = "call", "Call"
    EMAIL = "email", "Email"
    MEETING = "meeting", "Meeting"


class Update(TimestampedModel):
    """One entry on a lead's thread. ``lead`` is optional — a networking chat
    that isn't an opportunity yet still tags its people — but an update needs
    a lead or at least one person."""

    lead = models.ForeignKey(
        Lead,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="updates",
    )
    kind = models.CharField(max_length=16, choices=UpdateKind.choices, default=UpdateKind.NOTE)
    body = models.TextField()
    task = models.OneToOneField(
        "tasks.Task",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="crm_update",
        help_text="What they need next, filed by this update.",
    )
    occurred_at = models.DateTimeField(db_index=True)
    people = models.ManyToManyField(
        "meetings.Entity", related_name="crm_updates", blank=True
    )
    users = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="crm_updates",
        blank=True,
        help_text="Who from our side was on it.",
    )
    meeting = models.ForeignKey(
        "meetings.Meeting",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="crm_updates",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_crm_updates",
    )

    class Meta:
        ordering = ["-occurred_at", "-id"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.kind} {self.occurred_at:%Y-%m-%d}: {self.body[:40]}"
