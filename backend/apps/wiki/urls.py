"""Wiki URL config (mounted at /api/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import DocViewSet

router = DefaultRouter()
router.register(r"wiki-docs", DocViewSet, basename="wiki-doc")

urlpatterns = [
    path("", include(router.urls)),
]
