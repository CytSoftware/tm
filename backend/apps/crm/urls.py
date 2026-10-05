"""CRM URL config (mounted at /api/crm/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    ActivityView,
    CrmProjectsView,
    SitePreviewView,
    ContactViewSet,
    DealViewSet,
    FollowUpInboxView,
    FollowUpViewSet,
    PipelineViewSet,
    TouchpointViewSet,
)

router = DefaultRouter()
router.register(r"contacts", ContactViewSet, basename="crm-contact")
router.register(r"deals", DealViewSet, basename="crm-deal")
router.register(r"pipelines", PipelineViewSet, basename="crm-pipeline")
router.register(r"touchpoints", TouchpointViewSet, basename="crm-touchpoint")
router.register(r"follow-ups", FollowUpViewSet, basename="crm-follow-up")

urlpatterns = [
    path("inbox/", FollowUpInboxView.as_view(), name="crm-inbox"),
    path("activity/", ActivityView.as_view(), name="crm-activity"),
    path("site-preview/", SitePreviewView.as_view(), name="crm-site-preview"),
    path("projects/", CrmProjectsView.as_view(), name="crm-projects"),
    path("", include(router.urls)),
]
