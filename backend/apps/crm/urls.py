"""CRM URL config (mounted at /api/ by core/urls.py).

Routes:

    /api/contacts/                       — CRUD + list (paginated, filterable)
    /api/contacts/<key>/                 — detail (lookup by CONT-#### key)
    /api/contacts/import-preview/        — POST multipart, returns preview
    /api/contacts/import-apply/          — POST JSON with token + mapping
    /api/contacts/export/                — GET, streams filtered CSV
    /api/contact-labels/                 — CRUD on labels (no pagination)
"""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import ContactLabelViewSet, ContactViewSet


router = DefaultRouter()
router.register(r"contacts", ContactViewSet, basename="contact")
router.register(r"contact-labels", ContactLabelViewSet, basename="contact-label")


urlpatterns = [
    path("", include(router.urls)),
]
