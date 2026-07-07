"""Webhook management URL config (mounted at /api/ by core/urls.py).

Uses ``SimpleRouter`` — a second ``DefaultRouter`` under the same ``api/``
prefix would register another ``api-root`` view clashing with the one from
``apps/tasks/urls.py``.
"""

from rest_framework.routers import SimpleRouter

from .views import WebhookEndpointViewSet

router = SimpleRouter()
router.register(r"webhooks", WebhookEndpointViewSet, basename="webhook")

urlpatterns = router.urls
