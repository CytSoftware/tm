"""Drive URL config (mounted at /api/ by core/urls.py).

Plain ``path()`` routes — object keys carry ``/`` so they travel as query/body
params, not URL path segments (no router).
"""

from django.urls import path

from .views import (
    DriveDeleteView,
    DriveDownloadUrlView,
    DriveListView,
    DriveUploadUrlView,
)

urlpatterns = [
    path("drive/objects/", DriveListView.as_view(), name="drive-list"),
    path("drive/upload-url/", DriveUploadUrlView.as_view(), name="drive-upload-url"),
    path("drive/download-url/", DriveDownloadUrlView.as_view(), name="drive-download-url"),
    path("drive/delete/", DriveDeleteView.as_view(), name="drive-delete"),
]
