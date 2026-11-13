from django.contrib import admin

from .models import Lead, Licence, Payment, Update


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


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = ("due_on", "company", "title", "type", "amount", "paid_on", "project")
    list_filter = ("type", "project")
    search_fields = ("title", "company__name")
    raw_id_fields = ("company", "lead", "licence")


@admin.register(Licence)
class LicenceAdmin(admin.ModelAdmin):
    list_display = ("company", "title", "starts_on", "ends_on", "project")
    list_filter = ("project",)
    search_fields = ("title", "company__name")
    raw_id_fields = ("company", "lead")
