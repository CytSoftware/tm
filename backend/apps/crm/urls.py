"""CRM URL config (mounted at /api/crm/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    ActivityView,
    ContactViewSet,
    CrmProjectsView,
    LeadViewSet,
    LicenceViewSet,
    PaymentViewSet,
    StepView,
    UpdateViewSet,
)

router = DefaultRouter()
router.register(r"contacts", ContactViewSet, basename="crm-contact")
router.register(r"leads", LeadViewSet, basename="crm-lead")
router.register(r"updates", UpdateViewSet, basename="crm-update")
router.register(r"payments", PaymentViewSet, basename="crm-payment")
router.register(r"licences", LicenceViewSet, basename="crm-licence")

urlpatterns = [
    path("activity/", ActivityView.as_view(), name="crm-activity"),
    path("projects/", CrmProjectsView.as_view(), name="crm-projects"),
    path("steps/<str:key>/", StepView.as_view(), name="crm-step"),
    path("", include(router.urls)),
]
