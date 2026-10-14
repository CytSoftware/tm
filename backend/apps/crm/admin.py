from django.contrib import admin

from .models import Lead, Update


@admin.register(Lead)
class LeadAdmin(admin.ModelAdmin):
    list_display = ("key", "title", "stage", "company", "project")
    list_filter = ("stage", "project")
    search_fields = ("key", "title", "company__name")
    raw_id_fields = ("company",)


@admin.register(Update)
class UpdateAdmin(admin.ModelAdmin):
    list_display = ("occurred_at", "kind", "lead", "body")
    list_filter = ("kind",)
    raw_id_fields = ("lead", "people", "meeting")
