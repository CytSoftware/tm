from django.contrib import admin

from .models import Contact, ContactLabel


@admin.register(ContactLabel)
class ContactLabelAdmin(admin.ModelAdmin):
    list_display = ("name", "color", "created_at")
    search_fields = ("name",)
    ordering = ("name",)


@admin.register(Contact)
class ContactAdmin(admin.ModelAdmin):
    list_display = (
        "key",
        "first_name",
        "last_name",
        "company",
        "email",
        "country",
        "updated_at",
    )
    list_filter = ("country", "labels")
    search_fields = (
        "key",
        "first_name",
        "last_name",
        "company",
        "email",
        "phone",
        "notes",
    )
    readonly_fields = ("key", "created_at", "updated_at")
    filter_horizontal = ("labels",)
