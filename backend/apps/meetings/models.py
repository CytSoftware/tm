"""Meetings: recorded conversations pushed in by the PLAUD pipeline.

Conventions that matter:

* ``Meeting.stem`` is the pipeline's natural key (``2026-09-16-155009-c896f4``).
  Ingest upserts on it, so a re-push is always safe. ``Meeting.key``
  (``MTG-001``) is the human identifier and the DRF lookup field.
* People and companies are ``Entity`` rows, linked through ``MeetingEntity``
  with a role. They are the nodes that connect meetings to each other — links
  between meetings are *derived* from shared entities/project/tags (see
  ``related.py``); only the ones metadata can't infer are stored, as
  ``MeetingLink``.
* All text lives in the database. Audio never enters Task Manager.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction

from apps.tasks.models import TimestampedModel

from .id_generation import generate_meeting_key


class MeetingRoute(models.TextChoices):
    WORK = "work", "Work"
    PERSONAL = "personal", "Personal"


class MeetingCategory(models.TextChoices):
    CLIENT = "client", "Client meeting"
    INTERNAL = "internal", "Internal"
    PITCH_FEEDBACK = "pitch_feedback", "Pitch feedback"
    SALES = "sales", "Sales"
    INTERVIEW = "interview", "Interview"
    OTHER = "other", "Other"


class EntityKind(models.TextChoices):
    PERSON = "person", "Person"
    COMPANY = "company", "Company"


class EntityRole(models.TextChoices):
    ATTENDEE = "attendee", "Attendee"
    MENTIONED = "mentioned", "Mentioned"


class RelationshipType(models.TextChoices):
    """What an entity is to us, for the CRM (``apps.crm``).

    Blank means "not in the CRM": meetings auto-create an entity for everyone
    who speaks or is mentioned, and those stay out of CRM views until someone
    promotes them. ``internal`` (co-founders, staff) is kept for meetings but
    hidden from CRM views too.
    """

    CLIENT = "client", "Client"
    LEAD = "lead", "Lead"
    PARTNER = "partner", "Partner"
    ADVISOR = "advisor", "Advisor"
    INVESTOR = "investor", "Investor"
    OTHER = "other", "Other"
    INTERNAL = "internal", "Internal"


class MeetingLinkKind(models.TextChoices):
    FOLLOW_UP = "follow_up", "Follow-up"
    RELATED = "related", "Related"


class Entity(TimestampedModel):
    """A person or company that meetings are grouped and linked by.

    It is also the CRM's contact/company record (see ``apps.crm``): the
    ``relationship`` / ``owner`` / channel fields below are CRM state. Any new
    field needs a line in ``services.merge_entities`` so a merge doesn't drop it.
    """

    kind = models.CharField(max_length=16, choices=EntityKind.choices)
    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=200, allow_unicode=True)
    aliases = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "Other names that resolve to this entity on ingest. Merging an "
            "entity appends the losing name here so the pipeline keeps "
            "landing on the survivor."
        ),
    )
    wiki_slug = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="LLM-wiki page for this entity, e.g. 'entities/people/ali-k'.",
    )
    company = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="people",
        limit_choices_to={"kind": EntityKind.COMPANY},
        help_text="A person's employer. Gives the graph person→company edges.",
    )

    # -- CRM state (apps.crm) ----------------------------------------------
    relationship = models.CharField(
        max_length=16,
        choices=RelationshipType.choices,
        blank=True,
        default="",
        db_index=True,
        help_text="Blank = not in the CRM.",
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owned_entities",
    )
    headline = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text="One line — 'Regional Director of BIM, ECG'. The bio is the wiki's.",
    )
    phone = models.CharField(max_length=40, blank=True, default="")
    whatsapp = models.CharField(max_length=40, blank=True, default="")
    linkedin_url = models.URLField(max_length=300, blank=True, default="")
    website = models.URLField(max_length=300, blank=True, default="")
    projects = models.ManyToManyField(
        "tasks.Project",
        blank=True,
        related_name="crm_entities",
        help_text="Which of our businesses this contact is for (Mowafeq, Cyt…) — the CRM's scope.",
    )

    class Meta:
        ordering = ["kind", "name"]
        verbose_name_plural = "entities"
        constraints = [
            models.UniqueConstraint(
                fields=["kind", "slug"], name="entity_unique_slug_per_kind"
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.name} ({self.kind})"


class EntityEmail(models.Model):
    """An address that belongs to an entity.

    A table rather than a JSON list on ``Entity`` because matching Gmail and
    Calendar participants is a batch ``email__in`` lookup, and JSON containment
    isn't available on SQLite. Unique, so one address can't land on two people.
    """

    entity = models.ForeignKey(
        Entity, on_delete=models.CASCADE, related_name="emails"
    )
    email = models.EmailField(max_length=254, unique=True)

    class Meta:
        ordering = ["id"]

    def save(self, *args, **kwargs):
        self.email = (self.email or "").strip().lower()
        return super().save(*args, **kwargs)

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return self.email


class Tag(models.Model):
    """Free-form meeting topic. A row rather than a JSON list so filtering
    stays a portable join (JSON containment isn't available on SQLite)."""

    name = models.CharField(max_length=64, unique=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return self.name


class Meeting(TimestampedModel):
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)
    stem = models.CharField(
        max_length=128,
        unique=True,
        help_text="Pipeline recording id. Ingest upserts on this.",
    )
    title = models.CharField(max_length=300)
    started_at = models.DateTimeField(db_index=True)
    duration_seconds = models.PositiveIntegerField(null=True, blank=True)
    language = models.CharField(max_length=32, blank=True, default="")
    speaker_count = models.PositiveSmallIntegerField(null=True, blank=True)
    route = models.CharField(
        max_length=16, choices=MeetingRoute.choices, default=MeetingRoute.WORK
    )
    category = models.CharField(
        max_length=32,
        choices=MeetingCategory.choices,
        default=MeetingCategory.OTHER,
        db_index=True,
    )
    summary = models.TextField(blank=True, default="")
    brief_md = models.TextField(blank=True, default="")
    brief_html = models.TextField(
        blank=True,
        default="",
        help_text="Kept for fidelity/export. Never rendered by the app.",
    )
    transcript_md = models.TextField(blank=True, default="")
    gshr_url = models.URLField(max_length=500, blank=True, default="")
    action_items = models.JSONField(
        default=list,
        blank=True,
        help_text="[{id, text, owner, done, task_key}] — see services.merge_action_items.",
    )
    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meetings",
    )
    entities = models.ManyToManyField(
        Entity, through="MeetingEntity", related_name="meetings"
    )
    tags = models.ManyToManyField(Tag, blank=True, related_name="meetings")
    tasks = models.ManyToManyField(
        "tasks.Task", through="MeetingTask", related_name="meetings"
    )
    source_meta = models.JSONField(
        default=dict, blank=True, help_text="Raw pipeline/PLAUD metadata, verbatim."
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_meetings",
    )

    class Meta:
        ordering = ["-started_at", "-id"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        # Same contract as Task/Doc: the key is generated once, on first save,
        # inside the transaction that inserts the row.
        if self._state.adding and not self.key:
            with transaction.atomic():
                self.key = generate_meeting_key()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class MeetingEntity(models.Model):
    """Attendee vs mentioned is kept because "meetings Ali was in" and
    "meetings where Acme came up" are different questions."""

    meeting = models.ForeignKey(
        Meeting, on_delete=models.CASCADE, related_name="entity_links"
    )
    entity = models.ForeignKey(
        Entity, on_delete=models.CASCADE, related_name="meeting_links"
    )
    role = models.CharField(
        max_length=16, choices=EntityRole.choices, default=EntityRole.ATTENDEE
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "entity"], name="meeting_entity_unique"
            ),
        ]


class MeetingTask(TimestampedModel):
    """Join model, same shape as ``integrations.TaskPullRequest``."""

    meeting = models.ForeignKey(
        Meeting, on_delete=models.CASCADE, related_name="task_links"
    )
    task = models.ForeignKey(
        "tasks.Task", on_delete=models.CASCADE, related_name="meeting_links"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["meeting", "task"], name="meeting_task_unique"
            ),
        ]


class MeetingLink(TimestampedModel):
    """An explicit edge between two meetings ("this was the follow-up")."""

    from_meeting = models.ForeignKey(
        Meeting, on_delete=models.CASCADE, related_name="links_out"
    )
    to_meeting = models.ForeignKey(
        Meeting, on_delete=models.CASCADE, related_name="links_in"
    )
    kind = models.CharField(
        max_length=16,
        choices=MeetingLinkKind.choices,
        default=MeetingLinkKind.RELATED,
    )
    note = models.CharField(max_length=300, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["from_meeting", "to_meeting"], name="meeting_link_unique"
            ),
            models.CheckConstraint(
                condition=~models.Q(from_meeting=models.F("to_meeting")),
                name="meeting_link_not_self",
            ),
        ]


class MeetingCounter(models.Model):
    """Singleton holding the global ``MTG-<N>`` counter (see ``DocCounter``)."""

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    value = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)
