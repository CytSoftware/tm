"""Fire-and-forget WebSocket broadcasts for CRM writes.

One global ``crm`` group, so every open ``/crm`` page refetches. Follow-ups
are tasks and also broadcast into the CRM project's group; this covers
contacts, deals, touchpoints, pipelines and follow-up changes made here.

Rides :func:`apps.tasks.broadcast.broadcast_to_group`, so it reaches Daphne
from the MCP stdio process too. The consumer dispatch method is
``crm_event``, so the group message ``type`` must be ``"crm.event"``.
"""

from __future__ import annotations

import logging
from typing import Any

from apps.tasks.broadcast import broadcast_to_group

logger = logging.getLogger(__name__)

CRM_GROUP_NAME = "crm"


def broadcast_crm_event(event_type: str, payload: dict[str, Any] | None = None) -> None:
    """``event_type`` is e.g. ``contact.updated``, ``deal.moved``,
    ``touchpoint.created``, ``pipeline.updated``, ``follow_up.changed``.
    Must not throw."""
    try:
        broadcast_to_group(CRM_GROUP_NAME, "crm.event", {"type": event_type, **(payload or {})})
    except Exception:  # pragma: no cover - defensive
        logger.exception("crm broadcast failed")
