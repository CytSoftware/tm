"""LLM Wiki URL config (mounted at /api/ by core/urls.py)."""

from django.urls import path

from .views import KnowledgePageDetailView, KnowledgePageListView

urlpatterns = [
    path("knowledge/pages/", KnowledgePageListView.as_view(), name="knowledge-list"),
    path(
        "knowledge/pages/<path:slug>/",
        KnowledgePageDetailView.as_view(),
        name="knowledge-detail",
    ),
]
