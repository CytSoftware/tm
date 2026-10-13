from django.contrib import admin

from .models import Report


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    # Filing a report under a project (who can read it) is an admin edit.
    list_display = ["__str__", "project", "created_by", "created_at"]
    list_filter = ["project"]
    search_fields = ["title", "summary"]
    raw_id_fields = ["created_by"]
