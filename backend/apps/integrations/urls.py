"""URL config for the integrations app.

Mounted at ``/api/integrations/`` by ``core/urls.py``.
"""

from django.urls import path

from .webhooks import github_webhook_view

urlpatterns = [
    path("github/webhook/", github_webhook_view, name="github-webhook"),
]
