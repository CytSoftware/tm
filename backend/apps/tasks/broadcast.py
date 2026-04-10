"""Fire-and-forget WebSocket broadcasts for task mutations.

Every DRF write path, MCP write tool, and the recurring-task generator calls
``broadcast_task_event`` to push a message into the per-project Channels
group. Connected browsers (subscribed via ``apps.tasks.consumers.TaskConsumer``)
receive the event and invalidate their TanStack Query cache.

The consumer method that actually delivers messages is named ``task_event``,
so the ``type`` key of the group message must be ``"task.event"`` (Channels
converts dots to underscores when looking up the handler method).

Cross-process dispatch
----------------------
Phase 1 uses the in-memory channel layer. That layer is **process-local**,
which means broadcasts fired from a different process (e.g. ``manage.py
mcp_serve`` running alongside daphne) never reach the WebSocket consumers.

To keep the "LLM creates a task → browser updates live" story intact without
introducing Redis, we fall back to an HTTP bridge when the environment flag
``CYT_BROADCAST_URL`` is set. That URL points at the daphne process's
``/api/internal/broadcast/`` endpoint. Daphne receives the POST, calls this
same function (without the env var set), and the broadcast lands in its own
in-memory channel layer — where the browsers are actually listening.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


def project_group_name(project_id: int) -> str:
    return f"project_{project_id}"


def broadcast_task_event(
    project_id: int, event_type: str, payload: dict[str, Any]
) -> None:
    """Push an event to every browser subscribed to ``project_id``.

    ``event_type`` is one of ``task.created``, ``task.updated``, ``task.moved``,
    ``task.deleted``. The payload is passed through verbatim to the frontend.
    """
    bridge_url = os.environ.get("CYT_BROADCAST_URL")
    if bridge_url:
        _broadcast_via_http(bridge_url, project_id, event_type, payload)
        return
    _broadcast_local(project_id, event_type, payload)


def _broadcast_local(
    project_id: int, event_type: str, payload: dict[str, Any]
) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:  # pragma: no cover - defensive
        return
    async_to_sync(channel_layer.group_send)(
        project_group_name(project_id),
        {
            "type": "task.event",
            "payload": {"type": event_type, **payload},
        },
    )


def _broadcast_via_http(
    url: str, project_id: int, event_type: str, payload: dict[str, Any]
) -> None:
    """POST the broadcast to the daphne process's internal endpoint.

    Deliberately best-effort: broadcast failures must not break the caller.
    The daphne endpoint requires a shared secret header so arbitrary LAN
    clients can't spoof events.
    """
    # Local import so the HTTP client isn't loaded on the hot path when the
    # env var is unset (i.e. inside daphne).
    import json
    import urllib.error
    import urllib.request

    secret = os.environ.get("CYT_BROADCAST_SECRET", "")
    body = json.dumps(
        {
            "project_id": project_id,
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
        logger.warning("broadcast bridge POST to %s failed: %s", url, e)
    except Exception:  # pragma: no cover - defensive
        logger.exception("broadcast bridge POST raised")
