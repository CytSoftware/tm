"""Task tracker URL config (mounted at /api/ by core/urls.py)."""

from django.urls import include, path
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularSwaggerView,
)
from rest_framework.routers import DefaultRouter

from .views import (
    ColumnViewSet,
    LabelViewSet,
    LoginView,
    LogoutView,
    MeView,
    ProjectViewSet,
    RecurringTaskViewSet,
    StalenessSettingsView,
    TaskViewSet,
    UploadImageView,
    UserViewSet,
    ViewViewSet,
    csrf_view,
    internal_broadcast,
)

router = DefaultRouter()
router.register(r"projects", ProjectViewSet, basename="project")
router.register(r"columns", ColumnViewSet, basename="column")
router.register(r"labels", LabelViewSet, basename="label")
router.register(r"tasks", TaskViewSet, basename="task")
router.register(r"views", ViewViewSet, basename="view")
router.register(r"recurring-tasks", RecurringTaskViewSet, basename="recurring-task")
router.register(r"users", UserViewSet, basename="user")

urlpatterns = [
    path("auth/csrf/", csrf_view, name="csrf"),
    path("auth/login/", LoginView.as_view(), name="login"),
    path("auth/logout/", LogoutView.as_view(), name="logout"),
    path("auth/me/", MeView.as_view(), name="me"),
    path("uploads/", UploadImageView.as_view(), name="upload-image"),
    path("internal/broadcast/", internal_broadcast, name="internal-broadcast"),
    path(
        "settings/staleness/",
        StalenessSettingsView.as_view(),
        name="staleness-settings",
    ),
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    path(
        "schema/swagger/",
        SpectacularSwaggerView.as_view(url_name="schema"),
        name="swagger",
    ),
    path("", include(router.urls)),
]
