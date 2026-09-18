from django.contrib import admin

from .models import Entity, Meeting, MeetingEntity, MeetingLink, MeetingTask, Tag


class MeetingEntityInline(admin.TabularInline):
    model = MeetingEntity
    extra = 0
    autocomplete_fields = ("entity",)


@admin.register(Meeting)
class MeetingAdmin(admin.ModelAdmin):
    list_display = ("key", "title", "started_at", "category", "project")
    list_filter = ("category", "project")
    search_fields = ("key", "stem", "title", "summary")
    readonly_fields = ("key", "created_at", "updated_at")
    autocomplete_fields = ("project", "created_by")
    date_hierarchy = "started_at"
    inlines = [MeetingEntityInline]


@admin.register(Entity)
class EntityAdmin(admin.ModelAdmin):
    list_display = ("name", "kind", "company", "wiki_slug")
    list_filter = ("kind",)
    search_fields = ("name", "slug")
    autocomplete_fields = ("company",)


admin.site.register(Tag)
admin.site.register(MeetingTask)
admin.site.register(MeetingLink)
