"""Admin registration — kept minimal, used for sanity checking during dev."""

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import (
    Column,
    Label,
    Project,
    RecurringTaskTemplate,
    Task,
    UserProfile,
    View,
)

User = get_user_model()


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
        "updated_at",
    )
    list_filter = ("project", "column", "priority")
    search_fields = ("key", "title")
    autocomplete_fields = (
        "project",
        "column",
        "assignees",
        "reporter",
        "labels",
    )
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
    autocomplete_fields = (
        "project",
        "column",
        "assignees",
        "created_by",
        "labels",
    )


@admin.register(View)
class ViewAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "project", "kind", "shared", "updated_at")
    list_filter = ("kind", "shared", "project")
    search_fields = ("name",)


# ---------------------------------------------------------------------------
# UserProfile — inlined into the User admin so the avatar upload field
# lives next to the user in /admin/auth/user/<id>/change/.
# ---------------------------------------------------------------------------


class UserProfileInline(admin.StackedInline):
    model = UserProfile
    can_delete = False
    verbose_name_plural = "Profile"
    fk_name = "user"


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    """Standalone UserProfile admin for bulk browsing and direct edits."""

    list_display = ("user", "avatar_image", "avatar_url")
    search_fields = ("user__username", "user__email")
    autocomplete_fields = ("user",)


# Re-register the User admin with the profile inline attached.
admin.site.unregister(User)


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    inlines = (UserProfileInline,)
    list_display = DjangoUserAdmin.list_display + ("get_avatar_preview",)

    @admin.display(description="Avatar")
    def get_avatar_preview(self, obj):
        profile = getattr(obj, "profile", None)
        if not profile:
            return "—"
        url = profile.effective_avatar_url
        if not url:
            return "—"
        from django.utils.html import format_html

        return format_html(
            '<img src="{}" style="height:24px;width:24px;border-radius:50%;object-fit:cover" />',
            url,
        )
