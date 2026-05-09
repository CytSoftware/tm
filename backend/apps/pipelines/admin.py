from django.contrib import admin

from .models import Pipeline, PipelineEvent, Stage


@admin.register(Stage)
class StageAdmin(admin.ModelAdmin):
    list_display = ("name", "order", "color", "is_terminal")
    ordering = ("order",)


@admin.register(Pipeline)
class PipelineAdmin(admin.ModelAdmin):
    list_display = (
        "key",
        "title",
        "stage",
        "counterparty",
        "owner",
        "updated_at",
    )
    list_filter = ("stage",)
    search_fields = ("key", "title", "counterparty")
    readonly_fields = ("key", "created_at", "updated_at")
    autocomplete_fields = ("owner", "created_by")


@admin.register(PipelineEvent)
class PipelineEventAdmin(admin.ModelAdmin):
    list_display = ("pipeline", "author", "created_at")
    search_fields = ("body", "pipeline__key", "pipeline__title")
    readonly_fields = ("created_at",)
