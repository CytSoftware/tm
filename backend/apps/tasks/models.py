"""Task tracker data model.

Six models:

    Project                   — top-level container. Owns a task key prefix.
    Column                    — status columns on the Kanban board, per project.
    Label                     — colored labels, per project.
    Task                      — the work unit. Human key like "CYT-001".
    View                      — saved Notion-style filter+sort presets.
    RecurringTaskTemplate     — blueprints that generate Task instances on schedule.

Design notes:

* Task.key is unique across the whole tracker, generated atomically per project.
* Task.position is a float used for midpoint insertion inside a column
  (LexoRank-lite). Kept deliberately simple; we can migrate to strings later.
* RecurringTaskTemplate is the blueprint, not a Task. Completing a generated
  instance does not affect the template's schedule.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from .id_generation import generate_task_key


class Priority(models.TextChoices):
    LOW = "LOW", "Low"
    MEDIUM = "MEDIUM", "Medium"
    HIGH = "HIGH", "High"
    URGENT = "URGENT", "Urgent"


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Project(TimestampedModel):
    name = models.CharField(max_length=200)
    prefix = models.CharField(
        max_length=16,
        unique=True,
        help_text="Used as the human task key prefix, e.g. 'CYT' → CYT-001.",
    )
    description = models.TextField(blank=True, default="")
    color = models.CharField(
        max_length=9,
        default="#6366f1",
        help_text="CSS hex color used to theme the project in the sidebar.",
    )
    icon = models.CharField(
        max_length=8,
        blank=True,
        default="",
        help_text="Single emoji or short string shown next to the project name.",
    )
    archived = models.BooleanField(
        default=False,
        help_text="Archived projects are hidden from the default sidebar list.",
    )
    task_counter = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.name} ({self.prefix})"


class Column(TimestampedModel):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="columns"
    )
    name = models.CharField(max_length=80)
    order = models.PositiveSmallIntegerField()
    is_done = models.BooleanField(
        default=False,
        help_text="Marks a 'completed' column for analytics and recurring defaults.",
    )

    class Meta:
        ordering = ["project_id", "order"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "order"], name="column_unique_order_per_project"
            ),
            models.UniqueConstraint(
                fields=["project", "name"], name="column_unique_name_per_project"
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.project.prefix} / {self.name}"


class Label(TimestampedModel):
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="labels",
        null=True,
        blank=True,
        help_text="Null means this label is global (available to all projects).",
    )
    name = models.CharField(max_length=64)
    color = models.CharField(
        max_length=9,
        default="#888888",
        help_text="CSS hex color, e.g. '#ff00aa' or '#ff00aa88'.",
    )

    class Meta:
        ordering = ["project_id", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "name"],
                name="label_unique_name_per_project",
                condition=models.Q(project__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["name"],
                name="label_unique_name_global",
                condition=models.Q(project__isnull=True),
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        prefix = self.project.prefix if self.project else "Global"
        return f"{prefix}:{self.name}"


class Task(TimestampedModel):
    # ``key`` is blank at construction time; filled in by save() below.
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)
    title = models.CharField(max_length=300)
    description = models.TextField(
        blank=True,
        default="",
        help_text="TipTap JSON document, stored as opaque text.",
    )

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="tasks"
    )
    column = models.ForeignKey(
        Column, on_delete=models.CASCADE, related_name="tasks"
    )
    position = models.FloatField(
        default=1000.0,
        help_text="Sort order within a column. Midpoint insertion strategy.",
    )

    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_tasks",
    )
    labels = models.ManyToManyField(Label, related_name="tasks", blank=True)

    priority = models.CharField(
        max_length=8, choices=Priority.choices, default=Priority.MEDIUM
    )
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)

    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="reported_tasks",
    )

    recurrence_template = models.ForeignKey(
        "RecurringTaskTemplate",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="generated_tasks",
    )
    due_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["project_id", "column_id", "position", "id"]
        indexes = [
            models.Index(fields=["project", "column", "position"]),
            models.Index(fields=["project", "assignee"]),
            models.Index(fields=["project", "updated_at"]),
            models.Index(fields=["recurrence_template", "created_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        # Generate the human-readable key the first time the row is saved.
        if self._state.adding and not self.key:
            with transaction.atomic():
                self.key = generate_task_key(self.project)
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class RecurringTaskTemplate(TimestampedModel):
    """Blueprint that generates Task instances on an RRULE schedule."""

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="recurring_templates"
    )
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True, default="")

    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_recurring_templates",
    )
    labels = models.ManyToManyField(
        Label, related_name="recurring_templates", blank=True
    )

    priority = models.CharField(
        max_length=8, choices=Priority.choices, default=Priority.MEDIUM
    )
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)

    column = models.ForeignKey(
        Column, on_delete=models.CASCADE, related_name="recurring_templates"
    )

    rrule = models.CharField(
        max_length=500,
        help_text="RFC 5545 RRULE string, e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR'.",
    )
    dtstart = models.DateTimeField(
        help_text="Recurrence anchor — first scheduled occurrence."
    )
    timezone = models.CharField(
        max_length=64,
        default="UTC",
        help_text="IANA timezone name used to interpret rrule boundaries.",
    )
    next_run_at = models.DateTimeField(
        help_text="Cached next occurrence at-or-after now; the generator's hot field.",
    )
    last_generated_at = models.DateTimeField(null=True, blank=True)
    active = models.BooleanField(default=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="created_recurring_templates",
    )

    class Meta:
        ordering = ["project_id", "next_run_at"]
        indexes = [
            models.Index(fields=["active", "next_run_at"]),
            models.Index(fields=["project", "active"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.title} ({self.rrule})"


class View(TimestampedModel):
    """Saved Notion-style view: a named filter+sort preset."""

    class Kind(models.TextChoices):
        BOARD = "board", "Board"
        TABLE = "table", "Table"

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="views"
    )
    name = models.CharField(max_length=160)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="views",
        help_text="Null means 'all projects'.",
    )
    kind = models.CharField(
        max_length=8, choices=Kind.choices, default=Kind.BOARD
    )
    filters = models.JSONField(
        default=dict,
        blank=True,
        help_text='e.g. {"assignee": [1,2], "priority": ["HIGH","URGENT"], "labels": [3]}',
    )
    sort = models.JSONField(
        default=list,
        blank=True,
        help_text='e.g. [{"field": "priority", "dir": "desc"}]',
    )
    shared = models.BooleanField(
        default=False,
        help_text="If true, other users can see and apply this view.",
    )
    card_display = models.JSONField(
        null=True,
        blank=True,
        default=None,
        help_text=(
            'List of card field names to show, e.g. ["key","title","priority"]. '
            "Null means show everything."
        ),
    )

    class Meta:
        ordering = ["owner_id", "name"]

    def __str__(self) -> str:  # pragma: no cover
        return self.name


# ---------------------------------------------------------------------------
# User profile (avatar)
# ---------------------------------------------------------------------------


class UserProfile(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    avatar_url = models.URLField(
        blank=True,
        default="",
        help_text="URL to a profile picture (Gravatar, GitHub avatar, etc.).",
    )
    starred_projects = models.ManyToManyField(
        Project,
        blank=True,
        related_name="starred_by",
        help_text="Projects this user has pinned to the top of their sidebar.",
    )

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.user.username} profile"


@receiver(post_save, sender=settings.AUTH_USER_MODEL)
def _create_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.get_or_create(user=instance)


# ---------------------------------------------------------------------------
# Default columns for new projects
# ---------------------------------------------------------------------------
# A fresh Project gets a sensible default Kanban layout: Todo / In Progress /
# In Review / Done. The "Done" column is marked is_done=True so analytics and
# recurring defaults know which column means "completed".

DEFAULT_COLUMNS = [
    {"name": "Backlog", "order": 0, "is_done": False},
    {"name": "Todo", "order": 1, "is_done": False},
    {"name": "In Progress", "order": 2, "is_done": False},
    {"name": "In Review", "order": 3, "is_done": False},
    {"name": "Done", "order": 4, "is_done": True},
]


@receiver(post_save, sender=Project)
def _seed_default_columns(sender, instance: Project, created: bool, **kwargs):
    if not created:
        return
    Column.objects.bulk_create(
        [Column(project=instance, **col) for col in DEFAULT_COLUMNS]
    )
