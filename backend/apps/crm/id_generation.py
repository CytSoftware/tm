"""Atomic, global lead key generation (e.g. ``LEAD-001``).

Mirrors :mod:`apps.meetings.id_generation`: a single shared counter row is
bumped inside ``transaction.atomic`` + ``select_for_update`` so concurrent
creates serialize safely.
"""

from __future__ import annotations

from django.db import transaction

LEAD_PREFIX = "LEAD"


@transaction.atomic
def generate_lead_key() -> str:
    """Return the next ``LEAD-<N>`` key and bump the counter row. Must run in
    the same transaction as the ``Lead.save()`` that uses it."""
    from .models import LeadCounter

    counter, _ = LeadCounter.objects.select_for_update().get_or_create(
        pk=LeadCounter.SINGLETON_PK
    )
    counter.value = (counter.value or 0) + 1
    counter.save(update_fields=["value", "updated_at"])
    return f"{LEAD_PREFIX}-{counter.value:03d}"
