"""WebSocket URL routes for the wiki app (consumed by core/asgi.py).

Order matters: the bare tree route is matched before the per-document collab
route. The collab pattern allows an optional trailing slash because the
browser y-websocket provider connects to ``/ws/wiki/<key>`` without one.
"""

from django.urls import re_path

from .consumers import WikiDocConsumer, WikiTreeConsumer

websocket_urlpatterns = [
    re_path(r"^ws/wiki/$", WikiTreeConsumer.as_asgi()),
    re_path(r"^ws/wiki/(?P<key>[A-Za-z0-9\-]+)/?$", WikiDocConsumer.as_asgi()),
]
