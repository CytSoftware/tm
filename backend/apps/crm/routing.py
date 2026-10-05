"""WebSocket URL routes for the CRM app (consumed by core/asgi.py)."""

from django.urls import re_path

from .consumers import CrmConsumer

websocket_urlpatterns = [
    re_path(r"^ws/crm/$", CrmConsumer.as_asgi()),
]
