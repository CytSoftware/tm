"""Fire-and-forget WebSocket broadcasts for meeting and entity writes.

Mirrors :mod:`apps.wiki.broadcast`: lightweight JSON events on a single global
``meetings`` group, so every open ``/meetings`` page refetches. Meetings span
projects, so they don't ride the per-project task socket.

The consumer dispatch method is ``meeting_event``, so the group message
``type`` must be ``"meeting.event"`` (Channels converts dots to underscores
when resolving the handler method name).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


MEETINGS_GROUP_NAME = "meetings"


def broadcast_meeting_event(event_type: str, payload: dict[str, Any]) -> None:
    """Push an event to every browser subscribed to meetings.

    ``event_type`` is one of ``meeting.created``, ``meeting.updated``,
    ``meeting.deleted``, ``entity.updated``. Must not throw.
    """
    try:
        bridge_url = os.environ.get("CYT_BROADCAST_URL")
        if bridge_url:
            _broadcast_via_http(bridge_url, event_type, payload)
            return
        _broadcast_local(event_type, payload)
    except Exception:  # pragma: no cover - defensive
        logger.exception("meeting broadcast failed")


def _broadcast_local(event_type: str, payload: dict[str, Any]) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:  # pragma: no cover - defensive
        return
    async_to_sync(channel_layer.group_send)(
        MEETINGS_GROUP_NAME,
        {
            "type": "meeting.event",
            "payload": {"type": event_type, **payload},
        },
    )


def _broadcast_via_http(url: str, event_type: str, payload: dict[str, Any]) -> None:
    """POST the broadcast to daphne's internal endpoint (MCP stdio process).

    Best-effort: broadcast failures must not break the caller.
    """
    import json
    import urllib.error
    import urllib.request

    secret = os.environ.get("CYT_BROADCAST_SECRET", "")
    body = json.dumps(
        {
            "scope": "meetings",
            "type": event_type,
            "payload": payload,
        }
    ).encode()

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Cyt-Broadcast-Secret": secret,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except urllib.error.URLError as e:
        logger.warning("meeting broadcast bridge POST to %s failed: %s", url, e)
