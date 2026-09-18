"""Meetings URL config (mounted at /api/ by core/urls.py)."""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import EntityViewSet, MeetingViewSet

router = DefaultRouter()
router.register(r"meetings", MeetingViewSet, basename="meeting")
router.register(r"meeting-entities", EntityViewSet, basename="meeting-entity")

urlpatterns = [
    path("", include(router.urls)),
]
