"""Wiki URL config (mounted at /api/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import DocViewSet, internal_wiki_apply

router = DefaultRouter()
router.register(r"wiki-docs", DocViewSet, basename="wiki-doc")

urlpatterns = [
    path("", include(router.urls)),
    path("internal/wiki/apply/", internal_wiki_apply, name="internal-wiki-apply"),
]
