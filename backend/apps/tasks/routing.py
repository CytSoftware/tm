"""WebSocket URL routes for the tasks app (consumed by core/asgi.py)."""

from django.urls import re_path

from .consumers import TaskConsumer

websocket_urlpatterns = [
    re_path(
        r"^ws/projects/(?P<project_id>\d+)/$",
        TaskConsumer.as_asgi(),
    ),
]
