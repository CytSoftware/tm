"""WebSocket consumer for the global ``meetings`` group."""

from __future__ import annotations

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .broadcast import MEETINGS_GROUP_NAME


class MeetingsConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self) -> None:
        user = self.scope.get("user")
        if user is None or user.is_anonymous:
            await self.close(code=4401)
            return
        self.group_name = MEETINGS_GROUP_NAME
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "connected"})

    async def disconnect(self, code: int) -> None:
        group = getattr(self, "group_name", None)
        if group is not None:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def meeting_event(self, event: dict) -> None:
        """Handler invoked by group_send(type='meeting.event')."""
        await self.send_json(event["payload"])
