"""Admin registrations for MCP auth.

Also re-registers django-oauth-toolkit's ``Application`` admin. ``core/urls.py``
mounts only DOT's ``base_urlpatterns`` — its server-rendered application and
token management views are dropped, because they duplicate
``/settings/connections`` and render unstyled stock templates. But
``Application.get_absolute_url()`` reverses ``oauth2_provider:detail``, one of
those dropped routes, and the admin change form calls it to build its "View on
site" link. So the link has to be turned off, or the change page raises
``NoReverseMatch``.
"""

from django.contrib import admin
from oauth2_provider.admin import ApplicationAdmin as BaseApplicationAdmin
from oauth2_provider.models import get_application_model

from .models import McpAccessToken

Application = get_application_model()


class ApplicationAdmin(BaseApplicationAdmin):
    # See the module docstring: the target route is intentionally not mounted.
    view_on_site = False


admin.site.unregister(Application)
admin.site.register(Application, ApplicationAdmin)


@admin.register(McpAccessToken)
class McpAccessTokenAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "user",
        "token_prefix",
        "scopes",
        "created_at",
        "last_used_at",
        "expires_at",
        "revoked_at",
    )
    list_filter = ("revoked_at", "created_at")
    search_fields = ("name", "token_prefix", "user__username")
    # token_hash is deliberately absent: displaying it enables nothing (it can't
    # be reversed into a usable token) and invites treating it as a credential.
    readonly_fields = ("token_prefix", "created_at", "last_used_at")
    ordering = ("-created_at",)
