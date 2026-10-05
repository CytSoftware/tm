from django.contrib import admin

from .models import Deal, FollowUp, Pipeline, Stage, Touchpoint


class StageInline(admin.TabularInline):
    model = Stage
    extra = 0


@admin.register(Pipeline)
class PipelineAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "position")
    inlines = [StageInline]


@admin.register(Deal)
class DealAdmin(admin.ModelAdmin):
    list_display = ("key", "title", "pipeline", "stage", "company", "owner", "value")
    list_filter = ("pipeline", "stage")
    search_fields = ("key", "title", "company__name")
    raw_id_fields = ("company", "contacts")


@admin.register(Touchpoint)
class TouchpointAdmin(admin.ModelAdmin):
    list_display = ("occurred_at", "kind", "source", "summary")
    list_filter = ("kind", "source")
    raw_id_fields = ("entities", "deal")


@admin.register(FollowUp)
class FollowUpAdmin(admin.ModelAdmin):
    list_display = ("task", "entity", "deal")
    raw_id_fields = ("task", "entity", "deal")
