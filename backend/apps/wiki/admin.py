from django.contrib import admin

from .models import Doc, DocCounter, DocState


@admin.register(Doc)
class DocAdmin(admin.ModelAdmin):
    list_display = ("key", "title", "parent", "project", "last_edited_by", "updated_at")
    list_filter = ("project",)
    search_fields = ("key", "title", "plain_text")
    readonly_fields = ("key", "created_at", "updated_at")
    autocomplete_fields = ("parent", "project", "created_by", "last_edited_by")


@admin.register(DocState)
class DocStateAdmin(admin.ModelAdmin):
    list_display = ("doc", "updated_at")
    readonly_fields = ("doc", "updated_at")


@admin.register(DocCounter)
class DocCounterAdmin(admin.ModelAdmin):
    list_display = ("id", "value", "updated_at")
