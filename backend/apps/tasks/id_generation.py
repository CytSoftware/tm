"""Atomic, per-project task key generation (e.g. ``CYT-001``).

The ``Project.task_counter`` is the canonical counter. We bump it inside a
``@transaction.atomic`` block with ``select_for_update()`` on SQL backends that
support it. On SQLite, ``select_for_update()`` is a no-op, but the surrounding
transaction still serializes writes via SQLite's file lock — which is
sufficient for Phase 1's scale.
"""

from __future__ import annotations

from django.db import transaction


@transaction.atomic
def generate_task_key(project) -> str:
    """Return the next ``<PREFIX>-<N>`` key for ``project`` and bump its counter.

    Must be called inside the same transaction as the ``Task.save()`` that uses
    the returned key — otherwise a concurrent crash between the counter bump
    and the task insert would leak a counter value.
    """

    # Local import avoids a circular import with models.py.
    from .models import Project

    locked = Project.objects.select_for_update().get(pk=project.pk)
    locked.task_counter = (locked.task_counter or 0) + 1
    locked.save(update_fields=["task_counter", "updated_at"])
    return f"{locked.prefix}-{locked.task_counter:03d}"
