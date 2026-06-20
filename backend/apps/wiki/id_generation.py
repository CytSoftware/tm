"""Atomic, global wiki doc key generation (e.g. ``DOC-001``).

Mirrors :mod:`apps.pipelines.id_generation`. A single shared counter row is
bumped inside ``transaction.atomic`` + ``select_for_update`` so concurrent
creates serialize safely (on SQLite via the surrounding file lock).
"""

from __future__ import annotations

from django.db import transaction


DOC_PREFIX = "DOC"


@transaction.atomic
def generate_doc_key() -> str:
    """Return the next ``DOC-<N>`` key and bump the counter row.

    Must run inside the same transaction as the ``Doc.save()`` that uses the
    returned key, otherwise a crash between the bump and the insert would leak
    a counter value.
    """
    # Local import avoids a circular import with models.py.
    from .models import DocCounter

    counter = DocCounter.objects.select_for_update().get(
        pk=DocCounter.SINGLETON_PK
    )
    counter.value = (counter.value or 0) + 1
    counter.save(update_fields=["value", "updated_at"])
    return f"{DOC_PREFIX}-{counter.value:03d}"
