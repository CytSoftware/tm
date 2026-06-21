"""Server-side wiki body writes (Markdown → CRDT), driven by MCP.

The wiki body is a slate-yjs CRDT — the source of truth, owned by the live
collaborative editor. Python cannot faithfully *construct* that binary format
(its encoding lives in ``yjs`` + ``@slate-yjs/core``), so the actual Markdown↔
CRDT translation is delegated to a frontend route (``/api/wiki/encode``) that
reuses the editor's exact libraries. This module is the backend half:

* It reads the *current* CRDT state — the live in-memory room doc if the page
  is open in an editor, otherwise the persisted :class:`DocState` blob.
* It asks the frontend to produce an incremental update + new full state.
* If the page is live, it applies the update to the shared room doc and pushes
  it to every connected browser (so editors converge in real time).
* It persists the new state + a denormalized snapshot, and broadcasts a tree
  event so read-only views / search refresh.

The body-mutating work touches the in-memory room and the Channels layer, so it
**must run on daphne's event loop**. :func:`apply_content` is a coroutine; the
HTTP MCP transport (which runs inside daphne) awaits it directly, and the stdio
MCP process routes through an internal HTTP endpoint that re-enters the loop via
``async_to_sync`` (see :func:`apps.wiki.views.internal_wiki_apply`).
"""

from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.request
from typing import Any

from asgiref.sync import sync_to_async
from channels.layers import get_channel_layer
from django.conf import settings
from django.utils import timezone
from pycrdt import create_update_message

from .broadcast import WIKI_GROUP_NAME
from .consumers import _ROOMS, _load_state_sync
from .utils import extract_plain_text

logger = logging.getLogger(__name__)

VALID_OPERATIONS = ("replace", "append", "insert")


# ---------------------------------------------------------------------------
# Frontend encoder calls (sync; wrapped in sync_to_async by callers)
# ---------------------------------------------------------------------------


def _post_encode(payload: dict[str, Any]) -> dict[str, Any]:
    """POST to the frontend Markdown↔Yjs encoder. Raises on failure."""
    url = settings.WIKI_ENCODE_URL
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Cyt-Broadcast-Secret": settings.WIKI_ENCODE_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def serialize_markdown(content: Any) -> str | None:
    """Best-effort Plate value → Markdown via the frontend serializer.

    Used to enrich reads. Returns ``None`` (rather than raising) if the encoder
    is unreachable, so reads degrade gracefully to ``content`` + ``plain_text``.
    """
    if not isinstance(content, list) or not content:
        return ""
    try:
        result = _post_encode({"op": "to_markdown", "value": content})
        return result.get("markdown")
    except (urllib.error.URLError, OSError, ValueError):
        logger.warning("wiki: markdown serialization unavailable", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Persistence (sync; wrapped in sync_to_async by callers)
# ---------------------------------------------------------------------------


def _persist_and_snapshot(
    key: str, state: bytes, content: Any, user_id: int | None
) -> None:
    """Write the authoritative CRDT state + the denormalized read snapshot."""
    from .models import Doc, DocState

    doc_pk = Doc.objects.filter(key=key).values_list("pk", flat=True).first()
    if doc_pk is None:  # deleted under us
        return
    DocState.objects.update_or_create(doc_id=doc_pk, defaults={"state": state})
    Doc.objects.filter(pk=doc_pk).update(
        content=content,
        plain_text=extract_plain_text(content),
        last_edited_by_id=user_id,
        updated_at=timezone.now(),
    )


# ---------------------------------------------------------------------------
# Core (async; runs on daphne's event loop)
# ---------------------------------------------------------------------------


async def apply_content(
    key: str,
    *,
    markdown: str,
    operation: str,
    index: int | None,
    user_id: int | None,
) -> dict[str, Any]:
    """Apply a Markdown content write to a wiki page's body. Loop-bound.

    Returns a small status dict; callers fetch the full page separately so the
    read shape stays in one place.
    """
    if operation not in VALID_OPERATIONS:
        raise ValueError(f"Invalid operation: {operation!r}")

    exists = await sync_to_async(_doc_exists)(key)
    if not exists:
        raise ValueError(f"Wiki page not found: {key}")

    # Current authoritative state: the live room doc if open, else the DB blob.
    room = _ROOMS.get(key)
    if room is not None:
        current_state = room.doc.get_update()
    else:
        current_state = await sync_to_async(_load_state_sync)(key)

    encoded = await sync_to_async(_post_encode)(
        {
            "op": operation,
            "stateB64": base64.b64encode(current_state).decode() if current_state else "",
            "markdown": markdown,
            "index": index,
        }
    )
    diff = base64.b64decode(encoded["diffB64"])
    full = base64.b64decode(encoded["fullStateB64"])
    content = encoded["content"]

    if room is not None:
        # Merge into the shared room doc and push to every connected editor.
        room.doc.apply_update(diff)
        channel_layer = get_channel_layer()
        if channel_layer is not None:
            await channel_layer.group_send(
                f"wiki_doc_{key}",
                {"type": "send_message", "message": create_update_message(diff)},
            )
        # Persist the room's actual state (includes any concurrent edits merged
        # with our diff), not the encoder's view of it.
        new_state = room.doc.get_update()
    else:
        new_state = full

    await sync_to_async(_persist_and_snapshot)(key, new_state, content, user_id)

    # Tree event so sidebar / read-only render / search refresh.
    channel_layer = get_channel_layer()
    if channel_layer is not None:
        await channel_layer.group_send(
            WIKI_GROUP_NAME,
            {
                "type": "wiki.event",
                "payload": {"type": "wiki.updated", "key": key},
            },
        )

    return {"ok": True, "key": key, "operation": operation}


def _doc_exists(key: str) -> bool:
    from .models import Doc

    return Doc.objects.filter(key=key).exists()


# ---------------------------------------------------------------------------
# Cross-process bridge (stdio MCP → daphne)
# ---------------------------------------------------------------------------


def apply_content_via_bridge(
    bridge_url: str,
    key: str,
    *,
    markdown: str,
    operation: str,
    index: int | None,
    user_id: int | None,
) -> dict[str, Any]:
    """POST the whole content op to daphne's internal endpoint (stdio process).

    The stdio MCP process has no access to daphne's in-memory rooms or Channels
    layer, so it routes the operation to daphne, which runs :func:`apply_content`
    on its own event loop.
    """
    url = bridge_url.split("/internal/", 1)[0] + "/internal/wiki/apply/"
    body = json.dumps(
        {
            "key": key,
            "markdown": markdown,
            "operation": operation,
            "index": index,
            "user_id": user_id,
        }
    ).encode()
    # Matches the existing internal-broadcast bridge auth convention.
    secret = settings.CYT_BROADCAST_SECRET
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Cyt-Broadcast-Secret": secret,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())
