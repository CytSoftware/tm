"""Admin registration — kept minimal, used for sanity checking during dev."""

from django.contrib import admin

from .models import (
    Column,
    Label,
    Project,
    RecurringTaskTemplate,
    Task,
    View,
)


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("name", "prefix", "task_counter", "updated_at")
    search_fields = ("name", "prefix")


@admin.register(Column)
class ColumnAdmin(admin.ModelAdmin):
    list_display = ("project", "name", "order", "is_done")
    list_filter = ("project", "is_done")
    ordering = ("project", "order")
    search_fields = ("name", "project__name", "project__prefix")


@admin.register(Label)
class LabelAdmin(admin.ModelAdmin):
    list_display = ("project", "name", "color")
    list_filter = ("project",)
    search_fields = ("name",)


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = (
        "key",
        "title",
        "project",
        "column",
        "priority",
        "assignee",
        "updated_at",
    )
    list_filter = ("project", "column", "priority", "assignee")
    search_fields = ("key", "title")
    autocomplete_fields = ("project", "column", "assignee", "reporter", "labels")
    readonly_fields = ("key", "created_at", "updated_at")


@admin.register(RecurringTaskTemplate)
class RecurringTaskTemplateAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "project",
        "rrule",
        "next_run_at",
        "last_generated_at",
        "active",
    )
    list_filter = ("project", "active")
    search_fields = ("title", "rrule")
    autocomplete_fields = ("project", "column", "assignee", "created_by", "labels")


@admin.register(View)
class ViewAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "project", "kind", "shared", "updated_at")
    list_filter = ("kind", "shared", "project")
    search_fields = ("name",)
