"""Channels consumers for the wiki.

Two distinct sockets:

* :class:`WikiTreeConsumer` (``/ws/wiki/``) — a lightweight JSON relay on the
  global ``wiki`` group, exactly like ``PipelineConsumer``. Carries tree-shape
  events so the sidebar updates live.

* :class:`WikiDocConsumer` (``/ws/wiki/<key>/``) — the binary Yjs collab socket
  for one document, subclassing pycrdt-websocket's ``YjsConsumer``.

Collaboration correctness note
------------------------------
The stock ``YjsConsumer`` builds a *per-connection* ``self.ydoc`` and relays
peer bytes straight to browser sockets. Persisting from any single connection's
private doc loses concurrent peers' edits. We instead keep ONE shared,
refcounted ``Doc`` per room (per process) — every connection in the room shares
it, so a single observer sees the full update stream and a single debounced
writer persists it. This is single-process-correct (InMemoryChannelLayer); a
multi-worker future needs RedisChannelLayer.
"""

from __future__ import annotations

import asyncio
import logging

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from pycrdt import Doc
from pycrdt.websocket.django_channels_consumer import YjsConsumer

from .broadcast import WIKI_GROUP_NAME

logger = logging.getLogger(__name__)

PERSIST_DEBOUNCE_SECONDS = 0.75


# ---------------------------------------------------------------------------
# Tree socket — live sidebar updates
# ---------------------------------------------------------------------------


class WikiTreeConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self) -> None:
        user = self.scope.get("user")
        if user is None or user.is_anonymous:
            await self.close(code=4401)
            return
        self.group_name = WIKI_GROUP_NAME
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "connected"})

    async def disconnect(self, code: int) -> None:
        group = getattr(self, "group_name", None)
        if group is not None:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def wiki_event(self, event: dict) -> None:
        """Handler invoked by group_send(type='wiki.event')."""
        await self.send_json(event["payload"])


# ---------------------------------------------------------------------------
# Collab socket — shared per-room CRDT
# ---------------------------------------------------------------------------


class _Room:
    """Process-local state for one live document room."""

    __slots__ = ("key", "doc", "refcount", "dirty", "flush_handle", "subscription")

    def __init__(self, key: str, doc: Doc) -> None:
        self.key = key
        self.doc = doc
        self.refcount = 0
        self.dirty = False
        self.flush_handle: asyncio.TimerHandle | None = None
        self.subscription = None


_ROOMS: dict[str, _Room] = {}
_ROOMS_LOCK = asyncio.Lock()


def _doc_exists_sync(key: str) -> bool:
    from .models import Doc as DocModel

    return DocModel.objects.filter(key=key).exists()


def _load_state_sync(key: str) -> bytes:
    from .models import DocState

    row = (
        DocState.objects.filter(doc__key=key)
        .values_list("state", flat=True)
        .first()
    )
    return bytes(row) if row else b""


def _persist_state_sync(key: str, state: bytes) -> None:
    """Write the CRDT blob. No-op if the doc was deleted under us."""
    from .models import Doc as DocModel, DocState

    doc_pk = (
        DocModel.objects.filter(key=key).values_list("pk", flat=True).first()
    )
    if doc_pk is None:
        return
    DocState.objects.update_or_create(doc_id=doc_pk, defaults={"state": state})


def _mark_dirty(room: _Room) -> None:
    """Observer callback (sync) — (re)arm the debounced flush."""
    room.dirty = True
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - no loop, nothing to schedule
        return
    if room.flush_handle is not None:
        room.flush_handle.cancel()
    room.flush_handle = loop.call_later(
        PERSIST_DEBOUNCE_SECONDS, _schedule_flush, room
    )


def _schedule_flush(room: _Room) -> None:
    room.flush_handle = None
    asyncio.create_task(_flush_room(room))


async def _flush_room(room: _Room) -> None:
    if not room.dirty:
        return
    room.dirty = False
    try:
        update = room.doc.get_update()
    except Exception:  # pragma: no cover - defensive
        logger.exception("wiki: get_update failed for %s", room.key)
        return
    try:
        await sync_to_async(_persist_state_sync)(room.key, update)
    except Exception:  # pragma: no cover - fire-and-forget durability
        logger.exception("wiki: persist failed for %s", room.key)


class WikiDocConsumer(YjsConsumer):
    """Per-document Yjs collaboration over a shared, refcounted room doc."""

    async def connect(self) -> None:
        user = self.scope.get("user")
        if user is None or user.is_anonymous:
            await self.close(code=4401)
            return
        self._key = self.scope["url_route"]["kwargs"]["key"]
        if not await sync_to_async(_doc_exists_sync)(self._key):
            await self.close(code=4404)
            return
        await super().connect()

    def make_room_name(self) -> str:
        return f"wiki_doc_{self.scope['url_route']['kwargs']['key']}"

    async def make_ydoc(self) -> Doc:
        key = self.scope["url_route"]["kwargs"]["key"]
        async with _ROOMS_LOCK:
            room = _ROOMS.get(key)
            if room is None:
                doc = Doc()
                state = await sync_to_async(_load_state_sync)(key)
                if state:
                    try:
                        doc.apply_update(state)
                    except Exception:  # pragma: no cover - corrupt blob
                        logger.exception("wiki: failed to hydrate %s", key)
                room = _Room(key, doc)
                # Keep the subscription referenced on the room so it isn't GC'd.
                room.subscription = doc.observe(
                    lambda event, r=room: _mark_dirty(r)
                )
                _ROOMS[key] = room
            room.refcount += 1
            self._room = room
            return room.doc

    async def disconnect(self, code) -> None:
        try:
            await super().disconnect(code)
        except Exception:  # pragma: no cover - room_name may be unset
            pass
        room = getattr(self, "_room", None)
        if room is None:
            return
        async with _ROOMS_LOCK:
            room.refcount -= 1
            if room.refcount <= 0:
                if room.flush_handle is not None:
                    room.flush_handle.cancel()
                    room.flush_handle = None
                await _flush_room(room)
                _ROOMS.pop(room.key, None)
