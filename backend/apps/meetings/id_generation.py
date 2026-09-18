"""Atomic, global meeting key generation (e.g. ``MTG-001``).

Mirrors :mod:`apps.wiki.id_generation`: a single shared counter row is bumped
inside ``transaction.atomic`` + ``select_for_update`` so concurrent creates
serialize safely (on SQLite via the surrounding file lock).
"""

from __future__ import annotations

from django.db import transaction


MEETING_PREFIX = "MTG"


@transaction.atomic
def generate_meeting_key() -> str:
    """Return the next ``MTG-<N>`` key and bump the counter row.

    Must run inside the same transaction as the ``Meeting.save()`` that uses
    the returned key, otherwise a crash between the bump and the insert would
    leak a counter value.
    """
    # Local import avoids a circular import with models.py.
    from .models import MeetingCounter

    counter, _ = MeetingCounter.objects.select_for_update().get_or_create(
        pk=MeetingCounter.SINGLETON_PK
    )
    counter.value = (counter.value or 0) + 1
    counter.save(update_fields=["value", "updated_at"])
    return f"{MEETING_PREFIX}-{counter.value:03d}"
