"""URL config for the integrations app.

Mounted at ``/api/integrations/`` by ``core/urls.py``.
"""

from django.urls import path
from rest_framework.routers import SimpleRouter

from .routines import RoutineViewSet
from .views import (
    EventSourceViewSet,
    ExternalEventViewSet,
    InfrastructureServiceViewSet,
)
from .webhooks import event_source_ingest_view, github_webhook_view
from .pull_requests import GitHubPullRequestsView
from .repositories import GitHubRepositoriesView, ProjectRepositoriesView

router = SimpleRouter()
router.register(r"routines", RoutineViewSet, basename="routine")
router.register(r"event-sources", EventSourceViewSet, basename="event-source")
router.register(r"events", ExternalEventViewSet, basename="external-event")
router.register(r"services", InfrastructureServiceViewSet, basename="service")

urlpatterns = [
    path("github/pull-requests/", GitHubPullRequestsView.as_view()),
    path("github/repositories/", GitHubRepositoriesView.as_view()),
    path("projects/<int:project_id>/repositories/", ProjectRepositoriesView.as_view()),
    path("github/webhook/", github_webhook_view, name="github-webhook"),
    path(
        "event-sources/<uuid:token>/ingest/",
        event_source_ingest_view,
        name="event-source-ingest",
    ),
]

urlpatterns += router.urls
