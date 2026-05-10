"""CRM — flat contact table with extendable labels.

Design notes:

* One Contact table with a fixed schema. No per-contact custom fields — the
  user explicitly opted for filterable/sortable columns over flexibility.
* Labels are an M2M (``ContactLabel``) seeded with a small preset list and
  freely extendable. Same shape as the Task ``Label`` pattern.
* ``Contact.key`` is a globally unique human-readable identifier like
  ``CONT-0001``, generated atomically via ``id_generation.py``. Wider than
  PIPE-### (4 digits) since CRM data tends to grow faster.
* ``websites`` is a list of URLs and ``socials`` is a fixed-key dict
  ({"instagram", "linkedin", "facebook", "twitter"} → url). They stay as
  JSONFields rather than separate columns because they're never sort/filter
  targets beyond "has-X" (handled via ``__has_key`` / non-empty checks).
* No realtime broadcast in v1: a CRM table doesn't have the multi-watcher
  pressure tasks/pipelines do, and the broadcast bridge stays simpler.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction

from .id_generation import generate_contact_key


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class ContactLabel(models.Model):
    """Tag attached to contacts. Names are globally unique.

    Seeded with a preset list (Lead, Customer, Prospect, Contacted, VIP) and
    extendable from the UI or via CSV import (unknown label values during
    import auto-create a label).
    """

    name = models.CharField(max_length=80, unique=True)
    color = models.CharField(
        max_length=9,
        default="#6366f1",
        help_text="CSS hex color used to badge the label in the UI.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return self.name


class Contact(TimestampedModel):
    """Single flat contact record."""

    # Human key, filled on first save by ``id_generation.generate_contact_key``.
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)

    # Identity
    company = models.CharField(max_length=200, blank=True, default="")
    first_name = models.CharField(max_length=100, blank=True, default="")
    last_name = models.CharField(max_length=100, blank=True, default="")

    # Classification — free-text rather than enum so users aren't fenced into
    # a fixed taxonomy. Filtering uses icontains (substring) to forgive
    # variants like "Software Eng." vs "Software Engineer".
    industry = models.CharField(
        max_length=100,
        blank=True,
        default="",
        db_index=True,
        help_text="Type of company (e.g. 'Banking', 'SaaS', 'Manufacturing').",
    )
    job_title = models.CharField(
        max_length=100,
        blank=True,
        default="",
        db_index=True,
        help_text="Role of the person (e.g. 'CEO', 'Engineer', 'Sales Lead').",
    )

    # Contact channels
    email = models.EmailField(max_length=254, blank=True, default="")
    phone = models.CharField(max_length=50, blank=True, default="")

    # Address (structured so city/region/country are real filter targets).
    address_line1 = models.CharField(max_length=200, blank=True, default="")
    address_line2 = models.CharField(max_length=200, blank=True, default="")
    city = models.CharField(max_length=100, blank=True, default="")
    region = models.CharField(max_length=100, blank=True, default="")
    postal_code = models.CharField(max_length=20, blank=True, default="")
    country = models.CharField(
        max_length=2,
        blank=True,
        default="",
        help_text="ISO 3166-1 alpha-2 code (e.g. 'US', 'FR'). Empty = unknown.",
    )

    # Web presence
    websites = models.JSONField(
        default=list,
        blank=True,
        help_text="List of URL strings. Order is preserved.",
    )
    socials = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Fixed-key dict — allowed keys: 'instagram', 'linkedin', "
            "'facebook', 'twitter'. Values are URL strings."
        ),
    )

    # Labels (M2M)
    labels = models.ManyToManyField(
        ContactLabel,
        related_name="contacts",
        blank=True,
    )

    # Free text
    notes = models.TextField(blank=True, default="")

    # Attribution
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_contacts",
    )

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["company"]),
            models.Index(fields=["last_name", "first_name"]),
            models.Index(fields=["country"]),
            models.Index(fields=["city"]),
            models.Index(fields=["email"]),
            models.Index(fields=["created_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        name = (f"{self.first_name} {self.last_name}").strip()
        if name and self.company:
            return f"{self.key} {name} ({self.company})"
        return f"{self.key} {name or self.company or '(unnamed)'}"

    def save(self, *args, **kwargs):
        if self._state.adding and not self.key:
            with transaction.atomic():
                self.key = generate_contact_key()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class ContactCounter(models.Model):
    """Singleton holding the global ``CONT-<N>`` counter.

    Same pattern as PipelineCounter: a separate one-row table keeps the
    locking surface tiny — every create takes a row lock on this single
    ``id=1`` row and nothing else.
    """

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    value = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)


# ---------------------------------------------------------------------------
# Default labels seeded on first migrate.
# ---------------------------------------------------------------------------
DEFAULT_LABELS = [
    {"name": "Lead", "color": "#3b82f6"},
    {"name": "Prospect", "color": "#a855f7"},
    {"name": "Customer", "color": "#10b981"},
    {"name": "Contacted", "color": "#f59e0b"},
    {"name": "VIP", "color": "#ef4444"},
]


# Allowed social-media keys. Centralised so serializers, CSV import, and the
# frontend agree on the canonical list.
ALLOWED_SOCIAL_KEYS = ("instagram", "linkedin", "facebook", "twitter")
