"""Fire-and-forget WebSocket broadcasts for wiki tree mutations.

Mirrors :mod:`apps.pipelines.broadcast`. This carries only lightweight JSON
*tree-shape* events (create / rename / move / delete) on a single global
``wiki`` group, so every client's sidebar tree stays in sync. Body edits do
NOT come through here — they flow over the per-document Yjs collab socket.

The consumer dispatch method is ``wiki_event``, so the group message ``type``
must be ``"wiki.event"`` (Channels converts dots to underscores when resolving
the handler method name).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


WIKI_GROUP_NAME = "wiki"


def broadcast_wiki_event(event_type: str, payload: dict[str, Any]) -> None:
    """Push a tree event to every browser subscribed to the wiki.

    ``event_type`` is one of ``wiki.created``, ``wiki.updated``,
    ``wiki.moved``, ``wiki.deleted``.
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
        WIKI_GROUP_NAME,
        {
            "type": "wiki.event",
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
            "scope": "wiki",
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
        logger.warning("wiki broadcast bridge POST to %s failed: %s", url, e)
    except Exception:  # pragma: no cover - defensive
        logger.exception("wiki broadcast bridge POST raised")
