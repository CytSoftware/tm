"""Django Channels consumer for live task updates.

Browsers connect to ``ws/projects/<project_id>/`` once they know which project
they're looking at. On any mutation (DRF, MCP, or recurring generator), the
backend calls :func:`apps.tasks.broadcast.broadcast_task_event` which fans out
to every socket in the ``project_<id>`` group.

The consumer is intentionally dumb: it sends the event payload verbatim and
lets the frontend invalidate its TanStack Query cache. No diffing, no state
on the server side beyond the channel layer subscription.
"""

from __future__ import annotations

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .broadcast import project_group_name
from .notifications import user_group_name


class TaskConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self) -> None:
        user = self.scope.get("user")
        if user is None or user.is_anonymous:
            await self.close(code=4401)
            return

        self.project_id = int(self.scope["url_route"]["kwargs"]["project_id"])
        self.group_name = project_group_name(self.project_id)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "connected", "project_id": self.project_id})

    async def disconnect(self, code: int) -> None:
        group = getattr(self, "group_name", None)
        if group is not None:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def task_event(self, event: dict) -> None:
        """Handler invoked by group_send(type='task.event')."""
        await self.send_json(event["payload"])


class NotificationConsumer(AsyncJsonWebsocketConsumer):
    """Per-user notification stream at ``ws/notifications/``.

    Joins the ``user_<id>`` Channels group — the same group
    ``apps.tasks.notifications.notify_task_event`` pushes into (including
    from the MCP stdio process via the cross-process broadcast bridge).
    Anonymous connections are rejected; there's no project/session scoping
    beyond "this is your own notification stream."
    """

    async def connect(self) -> None:
        user = self.scope.get("user")
        if user is None or user.is_anonymous:
            await self.close(code=4401)
            return

        self.group_name = user_group_name(user.id)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "connected"})

    async def disconnect(self, code: int) -> None:
        group = getattr(self, "group_name", None)
        if group is not None:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def notify_event(self, event: dict) -> None:
        """Handler invoked by group_send(type='notify.event')."""
        await self.send_json(event["payload"])
