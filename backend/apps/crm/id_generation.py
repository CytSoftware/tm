"""Atomic, global deal key generation (e.g. ``DEAL-001``).

Mirrors :mod:`apps.meetings.id_generation`: a single shared counter row is
bumped inside ``transaction.atomic`` + ``select_for_update`` so concurrent
creates serialize safely.
"""

from __future__ import annotations

from django.db import transaction

DEAL_PREFIX = "DEAL"


@transaction.atomic
def generate_deal_key() -> str:
    """Return the next ``DEAL-<N>`` key and bump the counter row. Must run in
    the same transaction as the ``Deal.save()`` that uses it."""
    from .models import DealCounter

    counter, _ = DealCounter.objects.select_for_update().get_or_create(
        pk=DealCounter.SINGLETON_PK
    )
    counter.value = (counter.value or 0) + 1
    counter.save(update_fields=["value", "updated_at"])
    return f"{DEAL_PREFIX}-{counter.value:03d}"
