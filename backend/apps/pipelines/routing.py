"""WebSocket URL routes for the pipelines app (consumed by core/asgi.py)."""

from django.urls import re_path

from .consumers import PipelineConsumer

websocket_urlpatterns = [
    re_path(r"^ws/pipelines/$", PipelineConsumer.as_asgi()),
]
