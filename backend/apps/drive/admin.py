from django.contrib import admin

from .models import DriveFile, KnowledgePageProject


@admin.register(DriveFile)
class DriveFileAdmin(admin.ModelAdmin):
    list_display = ("key", "uploaded_by", "created_at")
    search_fields = ("key",)
    filter_horizontal = ("shared_with",)
    autocomplete_fields = ("uploaded_by",)


@admin.register(KnowledgePageProject)
class KnowledgePageProjectAdmin(admin.ModelAdmin):
    list_display = ("slug", "project")
    list_filter = ("project",)
    search_fields = ("slug",)
