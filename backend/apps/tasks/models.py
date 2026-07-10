"""Task tracker data model.

Core models:

    Project                   — top-level container. Owns a task key prefix.
    Column                    — status columns on the Kanban board, per project.
    Label                     — colored labels, per project.
    Task                      — the work unit. Human key like "CYT-001".
    View                      — saved Notion-style filter+sort presets.
    RecurringTaskTemplate     — blueprints that generate Task instances on schedule.
    Bet / Metric / Checkin    — Cyt OS bets: period-scoped, project-specific
                                bets that tasks link to, each tracked by
                                metrics with an append-only check-in log.

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

from django.core.validators import RegexValidator

from .id_generation import generate_task_key

# A GitHub "owner/repo" identifier. Owner and repo names allow letters,
# digits, dot, underscore, hyphen — same character set GitHub itself accepts.
GITHUB_REPO_REGEX = r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"
github_repo_validator = RegexValidator(
    regex=GITHUB_REPO_REGEX,
    message='Use the "owner/repo" format, e.g. "CytSoftware/tm".',
)


class Priority(models.TextChoices):
    # P1 = highest (was URGENT), P4 = lowest (was LOW).
    P1 = "P1", "P1"
    P2 = "P2", "P2"
    P3 = "P3", "P3"
    P4 = "P4", "P4"


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
        help_text="CSS hex color used to badge the project in cards and pickers.",
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
    github_repo = models.CharField(
        max_length=128,
        blank=True,
        default="",
        validators=[github_repo_validator],
        help_text=(
            'GitHub repository in "owner/repo" form, e.g. "CytSoftware/tm". '
            "Empty when no repository is linked. Used to surface PR/branch "
            "context next to the project and as the lookup key for the "
            "GitHub PR-review webhook (TAS-010 / TAS-011)."
        ),
    )
    task_counter = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.name} ({self.prefix})"


class ColumnKind(models.TextChoices):
    """Semantic role of a column, independent of its display name.

    Analytics (``apps.tasks.analytics``) codes against ``kind`` — not the
    column name — so a project renaming "In Progress" to "Doing" keeps its
    throughput series intact. ``DONE`` is the single semantic that
    ``is_done`` mirrors (see ``Column.save``).
    """

    BACKLOG = "backlog", "Backlog"
    TODO = "todo", "Todo"
    IN_PROGRESS = "in_progress", "In progress"
    REVIEW = "review", "Review"
    DONE = "done", "Done"
    OTHER = "other", "Other"


class Column(TimestampedModel):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="columns"
    )
    name = models.CharField(max_length=80)
    order = models.PositiveSmallIntegerField()
    kind = models.CharField(
        max_length=16,
        choices=ColumnKind.choices,
        default=ColumnKind.OTHER,
        help_text=(
            "Semantic role used by analytics. The single editing source of "
            "truth for completion — ``is_done`` is derived from it on save."
        ),
    )
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

    def save(self, *args, **kwargs):
        # ``kind`` is authoritative; ``is_done`` is a denormalized mirror kept
        # in lockstep so existing queries (recurring defaults, staleness,
        # analytics "completed") that key off ``is_done`` never diverge.
        self.is_done = self.kind == ColumnKind.DONE
        return super().save(*args, **kwargs)


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
        Project,
        on_delete=models.CASCADE,
        related_name="tasks",
        null=True,
        blank=True,
        help_text="Null means the task lives in the 'Inbox' (no project).",
    )
    column = models.ForeignKey(
        Column,
        on_delete=models.CASCADE,
        related_name="tasks",
        null=True,
        blank=True,
        help_text="Null for projectless tasks.",
    )
    position = models.FloatField(
        default=1000.0,
        help_text="Sort order within a column. Midpoint insertion strategy.",
    )

    assignees = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="assigned_tasks",
        blank=True,
    )
    labels = models.ManyToManyField(Label, related_name="tasks", blank=True)

    priority = models.CharField(
        max_length=8,
        choices=Priority.choices,
        null=True,
        blank=True,
        default=None,
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
    bet = models.ForeignKey(
        "Bet",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tasks",
        help_text=(
            "The bet this task serves (Cyt OS). Must belong to the task's "
            "project; cleared when the task moves to another project."
        ),
    )
    due_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["project_id", "column_id", "position", "id"]
        indexes = [
            models.Index(fields=["project", "column", "position"]),
            models.Index(fields=["project", "updated_at"]),
            models.Index(fields=["recurrence_template", "created_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        # Generate the human-readable key the first time the row is saved.
        if self._state.adding and not self.key:
            with transaction.atomic():
                if self.project_id:
                    self.key = generate_task_key(self.project)
                    self._assign_tail_position()
                    return super().save(*args, **kwargs)
                # Projectless task — save once to obtain an id, then stamp
                # the key as "INBOX-<id>" so it's still globally unique.
                super().save(*args, **kwargs)
                self.key = f"INBOX-{self.id:03d}"
                return super().save(update_fields=["key", "updated_at"])
        return super().save(*args, **kwargs)

    def _assign_tail_position(self):
        # Land at the bottom of the column with a fresh unique position.
        # The column's other tasks may all carry the model default (1000.0),
        # which would tie with this row and break midpoint drag-and-drop.
        if not self.column_id:
            return
        tail = (
            Task.objects.filter(column_id=self.column_id)
            .aggregate(m=models.Max("position"))["m"]
        )
        if tail is not None:
            self.position = tail + 1000.0


class RecurringTaskTemplate(TimestampedModel):
    """Blueprint that generates Task instances on an RRULE schedule."""

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="recurring_templates"
    )
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True, default="")

    assignees = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        related_name="assigned_recurring_templates",
        blank=True,
    )
    labels = models.ManyToManyField(
        Label, related_name="recurring_templates", blank=True
    )

    priority = models.CharField(
        max_length=8,
        choices=Priority.choices,
        null=True,
        blank=True,
        default=None,
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
        help_text='e.g. {"assignee": [1,2], "priority": ["P1","P2"], "labels": [3]}',
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
        help_text="External URL (Gravatar, GitHub, etc.). Used when no file is uploaded.",
    )
    avatar_image = models.ImageField(
        upload_to="avatars/",
        null=True,
        blank=True,
        help_text="Uploaded profile picture. Takes precedence over avatar_url.",
    )
    starred_projects = models.ManyToManyField(
        Project,
        blank=True,
        related_name="starred_by",
        help_text="Projects this user has pinned to the top of their sidebar.",
    )
    assign_hotkey_bindings = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Arbitrary key->user-id map for this user's personal hotkeys in "
            "the Assign-Todo triage dialog. Keys are normalized KeyboardEvent "
            "``key`` values (letters uppercased, arrow keys as 'ArrowLeft', "
            "'ArrowRight', 'ArrowUp'). Stored as {user's chosen key: target "
            "user id} so 'press key -> find user' is a direct dict lookup."
        ),
    )
    sidebar_project_order = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "Ordered list of project IDs defining this user's personal sidebar "
            "ordering (drag-to-reorder). A project's index in this list is its "
            "``sidebar_position``; IDs absent from the list sort last by name. "
            "Stale IDs (deleted projects) are ignored at read time."
        ),
    )
    board_column_prefs = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Per-user, per-project kanban column visibility. Shape: "
            '``{"<project_id>": {"hidden_columns": [<column_id>, ...]}}`` — '
            "project ids are stored as string keys (JSON object keys) and "
            "column ids as ints. Purely personal display state; doesn't "
            "affect teammates or the shared board layout."
        ),
    )

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.user.username} profile"

    @property
    def effective_avatar_url(self) -> str:
        """Return the best avatar URL — uploaded file first, external URL second."""
        if self.avatar_image:
            try:
                return self.avatar_image.url
            except ValueError:
                return ""
        return self.avatar_url or ""


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
    {"name": "Backlog", "order": 0, "kind": ColumnKind.BACKLOG},
    {"name": "Todo", "order": 1, "kind": ColumnKind.TODO},
    {"name": "In Progress", "order": 2, "kind": ColumnKind.IN_PROGRESS},
    {"name": "In Review", "order": 3, "kind": ColumnKind.REVIEW},
    {"name": "Done", "order": 4, "kind": ColumnKind.DONE},
]


@receiver(post_save, sender=Project)
def _seed_default_columns(sender, instance: Project, created: bool, **kwargs):
    if not created:
        return
    # bulk_create bypasses Column.save(), so mirror is_done from kind here to
    # keep the two in sync on the seeding path.
    Column.objects.bulk_create(
        [
            Column(
                project=instance,
                is_done=col["kind"] == ColumnKind.DONE,
                **col,
            )
            for col in DEFAULT_COLUMNS
        ]
    )


# ---------------------------------------------------------------------------
# Time-in-state tracking
# ---------------------------------------------------------------------------


class TransitionSource(models.TextChoices):
    USER = "user", "User"
    MCP = "mcp", "MCP"
    RECURRING = "recurring", "Recurring generator"
    BACKFILL = "backfill", "Backfill"
    GITHUB = "github", "GitHub webhook"


class TransitionEvent(models.TextChoices):
    """Why a state-transition row exists.

    Creation is deliberately explicit rather than inferred from a null
    ``from_column``: Inbox tasks are created without a column and may only be
    assigned one much later.
    """

    CREATED = "created", "Created"
    MOVED = "moved", "Moved"


class StateTransition(models.Model):
    """Immutable event log of task creation and every column change.

    Foreign keys support live navigation and staleness queries. Snapshot
    fields are the analytics source of truth and survive later edits/deletes.
    """

    task = models.ForeignKey(
        "Task",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="transitions",
    )
    from_column = models.ForeignKey(
        Column,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="transitions_from",
    )
    to_column = models.ForeignKey(
        Column,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="transitions_to",
    )
    at = models.DateTimeField()
    triggered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="triggered_transitions",
    )
    source = models.CharField(
        max_length=16,
        choices=TransitionSource.choices,
        default=TransitionSource.USER,
    )
    event_type = models.CharField(
        max_length=16,
        choices=TransitionEvent.choices,
        default=TransitionEvent.MOVED,
        help_text=(
            "Explicit event semantic. Creation must never be inferred from a "
            "null from_column because Inbox tasks begin without a column."
        ),
    )
    task_id_snapshot = models.PositiveBigIntegerField(
        help_text="Immutable task primary-key snapshot for durable distinct counts."
    )
    task_key_snapshot = models.CharField(
        max_length=32,
        help_text="Immutable human-readable task key snapshot.",
    )
    project_id_snapshot = models.PositiveBigIntegerField(
        null=True,
        blank=True,
        help_text="Immutable project id at the time of the event; null for Inbox.",
    )
    from_column_name = models.CharField(max_length=80, null=True, blank=True)
    to_column_name = models.CharField(max_length=80, null=True, blank=True)
    to_column_kind = models.CharField(
        max_length=16,
        choices=ColumnKind.choices,
        null=True,
        blank=True,
        help_text="Immutable semantic kind of the destination column.",
    )
    to_column_is_done = models.BooleanField(
        default=False,
        help_text="Immutable completion status of the destination column.",
    )
    assignee_ids = models.JSONField(
        default=list,
        help_text=(
            "Immutable snapshot of the task's assignee user ids at the moment "
            "of this transition. Assignees change over a task's life, so "
            "per-person analytics (e.g. weekly completions) must credit "
            "whoever was assigned *when the transition happened*, not whoever "
            "is assigned now."
        ),
    )

    class Meta:
        ordering = ["task_id", "at", "id"]
        indexes = [
            models.Index(fields=["task", "at"]),
            models.Index(fields=["task", "to_column"]),
            models.Index(fields=["project_id_snapshot", "event_type", "at"]),
            models.Index(fields=["project_id_snapshot", "to_column_kind", "at"]),
            models.Index(fields=["task_id_snapshot", "at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        frm = self.from_column_name or "∅"
        to = self.to_column_name or "∅"
        return f"{self.task_id_snapshot}: {frm} → {to} @ {self.at.isoformat()}"


# Default global thresholds applied to columns by name. Columns not listed
# here (and all ``is_done=True`` columns) never trigger a stale badge.
DEFAULT_STALE_THRESHOLDS: dict[str, dict[str, int]] = {
    "Backlog": {"yellow_days": 14, "red_days": 30},
    "Todo": {"yellow_days": 5, "red_days": 10},
    "In Progress": {"yellow_days": 5, "red_days": 10},
    "In Review": {"yellow_days": 3, "red_days": 7},
}


class FocusPeriod(models.TextChoices):
    """User-curated buckets on the personal focus list.

    ``DAY`` — work the user plans to do today.
    ``WEEK`` — work the user plans to do this week (the broader queue that
    items get promoted *from* into ``DAY`` when scheduled for the day).
    """

    DAY = "day", "Today"
    WEEK = "week", "This week"


class FocusItem(TimestampedModel):
    """A task that a specific user has pinned to their personal focus list.

    Per-user state, intentionally orthogonal to assignment — a user can focus
    on a task they aren't assigned to (e.g. they're shadowing it) and stay
    unassigned from a task they own end-to-end. Position is per-(user, period)
    midpoint-insertion so the user can rank within Today / This week.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="focus_items",
    )
    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="focus_pins",
    )
    period = models.CharField(
        max_length=8,
        choices=FocusPeriod.choices,
        default=FocusPeriod.WEEK,
    )
    position = models.FloatField(
        default=1000.0,
        help_text="Sort order within (user, period). Midpoint insertion.",
    )

    class Meta:
        ordering = ["user_id", "period", "position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "task"],
                name="focus_unique_user_task",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "period", "position"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.user_id} → {self.task_id} ({self.period})"


class StaleThresholdConfig(models.Model):
    """Singleton — global yellow/red thresholds keyed by column name.

    Keyed by name (not id) so the config applies uniformly to same-named
    columns across every project. "Done" columns (and any column not listed
    in ``thresholds``) are never considered stale regardless of configuration.
    """

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    thresholds = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            'Map of column name → {"yellow_days": N, "red_days": M}. '
            'Columns with is_done=True are always excluded.'
        ),
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "stale threshold config"
        verbose_name_plural = "stale threshold config"

    def save(self, *args, **kwargs):
        # Enforce singleton — force the primary key regardless of what the
        # caller passed. ``get_or_create`` in ``load()`` is the normal path.
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)

    @classmethod
    def load(cls) -> "StaleThresholdConfig":
        obj, _ = cls.objects.get_or_create(
            id=cls.SINGLETON_PK,
            defaults={"thresholds": DEFAULT_STALE_THRESHOLDS.copy()},
        )
        return obj


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


class NotificationVerb(models.TextChoices):
    ASSIGNED = "assigned", "Assigned"
    UPDATED = "updated", "Updated"
    MOVED = "moved", "Moved"
    COMPLETED = "completed", "Completed"
    DELETED = "deleted", "Deleted"


class Notification(models.Model):
    """A per-recipient notification generated by a task write path.

    Emitted by :func:`apps.tasks.notifications.notify_task_event` and never
    created directly. ``task``/``project`` are ``SET_NULL`` so a notification
    survives its source task being deleted — ``task_key``/``task_title`` are
    denormalized copies for exactly that reason. See
    :mod:`apps.tasks.notifications` for emission logic and
    :mod:`apps.tasks.consumers` for the per-user WebSocket push.
    """

    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notifications",
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="Who triggered the event. Null for system-generated events (e.g. recurring).",
    )
    task = models.ForeignKey(
        Task,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="notifications",
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    verb = models.CharField(max_length=16, choices=NotificationVerb.choices)
    # Denormalized so the notification stays legible after the task is gone.
    task_key = models.CharField(max_length=32, blank=True, default="")
    task_title = models.CharField(max_length=300, blank=True, default="")
    payload = models.JSONField(
        default=dict,
        blank=True,
        help_text='e.g. {"changed_fields": ["priority"]} or {"from_column": "Todo", "to_column": "Done"}',
    )
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["recipient", "read_at"]),
            models.Index(fields=["recipient", "created_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.recipient_id} <- {self.verb} {self.task_key}"


# ---------------------------------------------------------------------------
# Bets (Cyt OS)
# ---------------------------------------------------------------------------
# A Bet is a project-specific commitment for one two-month period (the fixed
# grid in ``periods.py`` — anchored July 1, 2026). Tasks link to the bet they
# serve via ``Task.bet``. Progress is tracked per-bet through Metrics, each
# with an append-only Checkin log (a check-in carries an optional numeric
# value and/or a free-text note, so countable and non-countable metrics share
# one shape).


class BetStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    WON = "won", "Won"
    LOST = "lost", "Lost"


class Bet(TimestampedModel):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="bets"
    )
    name = models.CharField(max_length=200)
    description = models.TextField(
        blank=True,
        default="",
        help_text="Target, kill criteria, context — free text.",
    )
    color = models.CharField(
        max_length=9,
        default="#6366f1",
        help_text="CSS hex color used for the bet chip on task cards.",
    )
    status = models.CharField(
        max_length=8,
        choices=BetStatus.choices,
        default=BetStatus.ACTIVE,
    )
    period_start = models.DateField(
        help_text=(
            "First day of the two-month period this bet belongs to. Any "
            "date is snapped to the start of its containing period on save."
        ),
    )

    class Meta:
        ordering = ["-period_start", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "period_start", "name"],
                name="bet_unique_name_per_project_period",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "period_start"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.project.prefix}: {self.name} ({self.period_start})"

    def save(self, *args, **kwargs):
        from .periods import current_period_start, period_start_for

        # Snap onto the period grid instead of validating — callers can pass
        # any date (or none, meaning "the current period") and always land on
        # a real period boundary.
        if self.period_start is None:
            self.period_start = current_period_start()
        else:
            self.period_start = period_start_for(self.period_start)
        return super().save(*args, **kwargs)

    @property
    def period_label(self) -> str:
        from .periods import period_label

        return period_label(self.period_start)

    @property
    def period_end(self):
        from .periods import period_end

        return period_end(self.period_start)


class Metric(TimestampedModel):
    """One trackable signal on a bet (a bet typically carries 1–2).

    ``target``/``unit`` are optional — countable metrics use them ("10
    signups"); qualitative metrics are just a name whose check-ins carry
    notes instead of values.
    """

    bet = models.ForeignKey(Bet, on_delete=models.CASCADE, related_name="metrics")
    name = models.CharField(max_length=200)
    target = models.FloatField(null=True, blank=True)
    unit = models.CharField(max_length=32, blank=True, default="")

    class Meta:
        ordering = ["bet_id", "id"]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.bet_id}: {self.name}"


class Checkin(TimestampedModel):
    """Append-only progress log entry on a metric.

    ``value`` and ``note`` are both optional (a check-in needs at least one
    to be useful — enforced at the API/MCP layer, not the DB). History is the
    point: the latest check-in is a metric's current reading, the sequence is
    its trend.
    """

    metric = models.ForeignKey(
        Metric, on_delete=models.CASCADE, related_name="checkins"
    )
    value = models.FloatField(null=True, blank=True)
    note = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="metric_checkins",
    )

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["metric", "created_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.metric_id} @ {self.created_at:%Y-%m-%d}: {self.value}"
