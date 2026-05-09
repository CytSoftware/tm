"""Atomic, global pipeline key generation (e.g. ``PIPE-001``).

Pipelines have a single shared counter (no per-board prefix in v1). We bump
it inside ``transaction.atomic`` with ``select_for_update`` to serialize
concurrent creates safely on SQLite via the surrounding file-lock.

The counter row is seeded by the initial data migration, so we can take a
simple ``select_for_update().get(pk=SINGLETON_PK)`` here.
"""

from __future__ import annotations

from django.db import transaction


PIPELINE_PREFIX = "PIPE"


@transaction.atomic
def generate_pipeline_key() -> str:
    """Return the next ``PIPE-<N>`` key and bump the counter row.

    Must be called inside the same transaction as the ``Pipeline.save()`` that
    uses the returned key — otherwise a crash between the bump and the insert
    would leak a counter value.
    """
    # Local import avoids a circular import with models.py.
    from .models import PipelineCounter

    counter = PipelineCounter.objects.select_for_update().get(
        pk=PipelineCounter.SINGLETON_PK
    )
    counter.value = (counter.value or 0) + 1
    counter.save(update_fields=["value", "updated_at"])
    return f"{PIPELINE_PREFIX}-{counter.value:03d}"
