"""CRM URL config (mounted at /api/crm/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    ActivityView,
    ContactViewSet,
    CrmProjectsView,
    LeadViewSet,
    StepView,
    UpdateViewSet,
)

router = DefaultRouter()
router.register(r"contacts", ContactViewSet, basename="crm-contact")
router.register(r"leads", LeadViewSet, basename="crm-lead")
router.register(r"updates", UpdateViewSet, basename="crm-update")

urlpatterns = [
    path("activity/", ActivityView.as_view(), name="crm-activity"),
    path("projects/", CrmProjectsView.as_view(), name="crm-projects"),
    path("steps/<str:key>/", StepView.as_view(), name="crm-step"),
    path("", include(router.urls)),
]
