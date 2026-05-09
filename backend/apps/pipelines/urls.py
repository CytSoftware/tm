"""Pipelines URL config (mounted at /api/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import PipelineViewSet, StageViewSet

router = DefaultRouter()
router.register(r"pipelines", PipelineViewSet, basename="pipeline")
router.register(r"pipeline-stages", StageViewSet, basename="pipeline-stage")

urlpatterns = [
    path("", include(router.urls)),
]
