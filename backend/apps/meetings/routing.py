"""WebSocket URL routes for the meetings app (consumed by core/asgi.py)."""

from django.urls import re_path

from .consumers import MeetingsConsumer

websocket_urlpatterns = [
    re_path(r"^ws/meetings/$", MeetingsConsumer.as_asgi()),
]
