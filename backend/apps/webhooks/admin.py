from django.contrib import admin

from .models import WebhookDelivery, WebhookEndpoint


@admin.register(WebhookEndpoint)
class WebhookEndpointAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "user",
        "url",
        "project",
        "active",
        "consecutive_failures",
        "updated_at",
    )
    list_filter = ("active", "project")
    search_fields = ("name", "url", "user__username")
    autocomplete_fields = ("user", "project")
    # ``secret`` is intentionally readonly (never hand-edited — rotation goes
    # through secrets.token_hex via the API) and kept out of list_display.
    readonly_fields = ("secret", "consecutive_failures", "disabled_at", "created_at", "updated_at")


@admin.register(WebhookDelivery)
class WebhookDeliveryAdmin(admin.ModelAdmin):
    list_display = (
        "event",
        "endpoint",
        "status",
        "attempts",
        "response_status",
        "next_attempt_at",
        "created_at",
    )
    list_filter = ("status", "event")
    search_fields = ("endpoint__name", "task_key")
    autocomplete_fields = ("endpoint", "task")
    readonly_fields = (
        "id",
        "endpoint",
        "event",
        "task",
        "task_key",
        "payload",
        "response_status",
        "response_body",
        "error",
        "created_at",
    )
