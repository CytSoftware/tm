"""Fire-and-forget WebSocket broadcasts for CRM writes.

Same shape as :mod:`apps.meetings.broadcast`: one global ``crm`` group, so
every open ``/crm`` page refetches. Follow-ups are tasks and already broadcast
into the CRM project's group; this covers contacts, deals, touchpoints and
pipelines.

The consumer dispatch method is ``crm_event``, so the group message ``type``
must be ``"crm.event"``.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)

CRM_GROUP_NAME = "crm"


def broadcast_crm_event(event_type: str, payload: dict[str, Any] | None = None) -> None:
    """``event_type`` is e.g. ``contact.updated``, ``deal.moved``,
    ``touchpoint.created``, ``pipeline.updated``, ``follow_up.changed``.
    Must not throw."""
    payload = payload or {}
    try:
        bridge_url = os.environ.get("CYT_BROADCAST_URL")
        if bridge_url:
            _broadcast_via_http(bridge_url, event_type, payload)
            return
        _broadcast_local(event_type, payload)
    except Exception:  # pragma: no cover - defensive
        logger.exception("crm broadcast failed")


def _broadcast_local(event_type: str, payload: dict[str, Any]) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:  # pragma: no cover - defensive
        return
    async_to_sync(channel_layer.group_send)(
        CRM_GROUP_NAME,
        {"type": "crm.event", "payload": {"type": event_type, **payload}},
    )


def _broadcast_via_http(url: str, event_type: str, payload: dict[str, Any]) -> None:
    """POST to daphne's internal bridge (MCP stdio process). Best-effort."""
    import json
    import urllib.error
    import urllib.request

    body = json.dumps({"scope": "crm", "type": event_type, "payload": payload}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Cyt-Broadcast-Secret": os.environ.get("CYT_BROADCAST_SECRET", ""),
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except urllib.error.URLError as e:
        logger.warning("crm broadcast bridge POST to %s failed: %s", url, e)
