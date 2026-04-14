"""Add StateTransition log + StaleThresholdConfig singleton.

Also backfills one StateTransition per existing Task using
``created_at`` → current column, so the UI can compute time-in-column for
tasks that existed before this migration ran.
"""

from django.conf import settings
from django.db import migrations, models


def backfill_initial_transitions(apps, schema_editor):
    """One synthetic transition per existing task so staleness works day-one.

    Each task gets a row with ``from_column=NULL``, ``to_column=<current>``,
    ``at=<task.created_at>``, ``source='backfill'``. Tasks without a column
    are skipped — nothing to anchor staleness to.
    """
    Task = apps.get_model("tasks", "Task")
    StateTransition = apps.get_model("tasks", "StateTransition")

    rows = []
    for task in Task.objects.all().only("id", "column_id", "created_at").iterator():
        if task.column_id is None:
            continue
        rows.append(
            StateTransition(
                task_id=task.id,
                from_column_id=None,
                to_column_id=task.column_id,
                at=task.created_at,
                triggered_by_id=None,
                source="backfill",
            )
        )
    if rows:
        StateTransition.objects.bulk_create(rows, batch_size=500)


def remove_backfill_transitions(apps, schema_editor):
    StateTransition = apps.get_model("tasks", "StateTransition")
    StateTransition.objects.filter(source="backfill").delete()


def seed_default_stale_config(apps, schema_editor):
    """Seed the singleton with sensible defaults."""
    StaleThresholdConfig = apps.get_model("tasks", "StaleThresholdConfig")
    # Keep in sync with DEFAULT_STALE_THRESHOLDS in models.py. Duplicated
    # here because migrations shouldn't import the live models module.
    defaults = {
        "Backlog": {"yellow_days": 14, "red_days": 30},
        "Todo": {"yellow_days": 5, "red_days": 10},
        "In Progress": {"yellow_days": 5, "red_days": 10},
        "In Review": {"yellow_days": 3, "red_days": 7},
    }
    StaleThresholdConfig.objects.get_or_create(
        id=1, defaults={"thresholds": defaults}
    )


def clear_stale_config(apps, schema_editor):
    StaleThresholdConfig = apps.get_model("tasks", "StaleThresholdConfig")
    StaleThresholdConfig.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("tasks", "0010_project_metadata_and_starred"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="StateTransition",
            fields=[
                (
                    "id",
                    models.AutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("at", models.DateTimeField()),
                (
                    "source",
                    models.CharField(
                        choices=[
                            ("user", "User"),
                            ("mcp", "MCP"),
                            ("recurring", "Recurring generator"),
                            ("backfill", "Backfill"),
                        ],
                        default="user",
                        max_length=16,
                    ),
                ),
                (
                    "from_column",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.SET_NULL,
                        related_name="transitions_from",
                        to="tasks.column",
                    ),
                ),
                (
                    "to_column",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.SET_NULL,
                        related_name="transitions_to",
                        to="tasks.column",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=models.CASCADE,
                        related_name="transitions",
                        to="tasks.task",
                    ),
                ),
                (
                    "triggered_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.SET_NULL,
                        related_name="triggered_transitions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["task_id", "at", "id"],
            },
        ),
        migrations.AddIndex(
            model_name="statetransition",
            index=models.Index(
                fields=["task", "at"], name="tasks_state_task_id_at_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="statetransition",
            index=models.Index(
                fields=["task", "to_column"],
                name="tasks_state_task_to_idx",
            ),
        ),
        migrations.CreateModel(
            name="StaleThresholdConfig",
            fields=[
                (
                    "id",
                    models.PositiveSmallIntegerField(
                        default=1, primary_key=True, serialize=False
                    ),
                ),
                (
                    "thresholds",
                    models.JSONField(
                        blank=True,
                        default=dict,
                        help_text=(
                            "Map of column name → {\"yellow_days\": N, \"red_days\": M}. "
                            "Columns with is_done=True are always excluded."
                        ),
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "stale threshold config",
                "verbose_name_plural": "stale threshold config",
            },
        ),
        migrations.RunPython(seed_default_stale_config, clear_stale_config),
        migrations.RunPython(
            backfill_initial_transitions, remove_backfill_transitions
        ),
    ]
