"""Fire-and-forget WebSocket broadcasts for pipeline mutations.

Mirrors :mod:`apps.tasks.broadcast` — same dispatch shape, same cross-process
HTTP bridge for the MCP stdio process. All pipelines live on a single global
board (no per-board scoping in v1), so we use a single Channels group.

The consumer dispatch method is named ``pipeline_event``, which means the
``type`` key on the group message must be ``"pipeline.event"`` (Channels
converts dots to underscores when resolving the handler method name).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


PIPELINE_GROUP_NAME = "pipelines"


def broadcast_pipeline_event(event_type: str, payload: dict[str, Any]) -> None:
    """Push an event to every browser subscribed to the pipelines board.

    ``event_type`` is one of ``pipeline.created``, ``pipeline.updated``,
    ``pipeline.moved``, ``pipeline.deleted``, ``pipeline.event_added``.
    """
    bridge_url = os.environ.get("CYT_BROADCAST_URL")
    if bridge_url:
        _broadcast_via_http(bridge_url, event_type, payload)
        return
    _broadcast_local(event_type, payload)


def _broadcast_local(event_type: str, payload: dict[str, Any]) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:  # pragma: no cover - defensive
        return
    async_to_sync(channel_layer.group_send)(
        PIPELINE_GROUP_NAME,
        {
            "type": "pipeline.event",
            "payload": {"type": event_type, **payload},
        },
    )


def _broadcast_via_http(
    url: str, event_type: str, payload: dict[str, Any]
) -> None:
    """POST the broadcast to the daphne process's internal endpoint.

    Best-effort: broadcast failures must not break the caller. The shared
    secret + loopback gate live on the receiving end.
    """
    import json
    import urllib.error
    import urllib.request

    secret = os.environ.get("CYT_BROADCAST_SECRET", "")
    body = json.dumps(
        {
            "scope": "pipelines",
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
        logger.warning("pipeline broadcast bridge POST to %s failed: %s", url, e)
    except Exception:  # pragma: no cover - defensive
        logger.exception("pipeline broadcast bridge POST raised")
