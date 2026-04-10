"""Root URL config.

The task tracker API lives under /api/. The Django admin is mounted at /admin/
for quick sanity checking during development.
"""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("apps.tasks.urls")),
]
