"""Atomic, global contact key generation (e.g. ``CONT-0001``).

Mirrors :mod:`apps.pipelines.id_generation`: bumps a singleton counter row
inside ``transaction.atomic`` with ``select_for_update`` so concurrent
creates serialize safely.
"""

from __future__ import annotations

from django.db import transaction


CONTACT_PREFIX = "CONT"


@transaction.atomic
def generate_contact_key() -> str:
    """Return the next ``CONT-<N>`` key and bump the counter row.

    Must run inside the same transaction as the ``Contact.save()`` call that
    consumes the key — otherwise a crash between the bump and the insert
    leaks a counter value.
    """
    # Local import avoids a circular import with models.py.
    from .models import ContactCounter

    counter = ContactCounter.objects.select_for_update().get(
        pk=ContactCounter.SINGLETON_PK
    )
    counter.value = (counter.value or 0) + 1
    counter.save(update_fields=["value", "updated_at"])
    return f"{CONTACT_PREFIX}-{counter.value:04d}"
