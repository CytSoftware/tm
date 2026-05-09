"""Channels consumer for live pipeline updates.

Browsers connect to ``ws/pipelines/`` once they're on the pipelines page. The
consumer joins the single global ``pipelines`` group and forwards every
``pipeline.event`` message verbatim to the socket. The frontend invalidates
its TanStack Query caches in response.
"""

from __future__ import annotations

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .broadcast import PIPELINE_GROUP_NAME


class PipelineConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self) -> None:
        user = self.scope.get("user")
        if user is None or user.is_anonymous:
            await self.close(code=4401)
            return

        self.group_name = PIPELINE_GROUP_NAME
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "connected"})

    async def disconnect(self, code: int) -> None:
        group = getattr(self, "group_name", None)
        if group is not None:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def pipeline_event(self, event: dict) -> None:
        """Handler invoked by group_send(type='pipeline.event')."""
        await self.send_json(event["payload"])
