"""Make analytics events durable and semantically explicit.

Historical rows cannot reveal whether a null ``from_column`` meant true task
creation or a later first assignment from Inbox. Treat every existing row as
a move, then add one synthetic creation event at each extant task's real
``created_at``. This guarantees one creation per task and retains the old
column-entry rows for stage/completion analytics.

Project and assignee history before this migration is only recoverable from
current task state; all events written after it carry exact point-in-time
snapshots.
"""

from django.db import migrations, models
import django.db.models.deletion


def backfill_analytics_snapshots(apps, schema_editor):
    StateTransition = apps.get_model("tasks", "StateTransition")
    Task = apps.get_model("tasks", "Task")

    transitions = list(
        StateTransition.objects.select_related("task", "from_column", "to_column")
    )
    for transition in transitions:
        task = transition.task
        transition.event_type = "moved"
        transition.task_id_snapshot = task.id
        transition.task_key_snapshot = task.key
        transition.project_id_snapshot = task.project_id
        transition.from_column_name = (
            transition.from_column.name if transition.from_column_id else None
        )
        transition.to_column_name = (
            transition.to_column.name if transition.to_column_id else None
        )
        transition.to_column_kind = (
            transition.to_column.kind if transition.to_column_id else None
        )
        transition.to_column_is_done = bool(
            transition.to_column_id and transition.to_column.is_done
        )
    if transitions:
        StateTransition.objects.bulk_update(
            transitions,
            [
                "event_type",
                "task_id_snapshot",
                "task_key_snapshot",
                "project_id_snapshot",
                "from_column_name",
                "to_column_name",
                "to_column_kind",
                "to_column_is_done",
            ],
            batch_size=500,
        )

    creations = []
    for task in Task.objects.prefetch_related("assignees").iterator(chunk_size=200):
        creations.append(
            StateTransition(
                task_id=task.id,
                from_column_id=None,
                to_column_id=None,
                at=task.created_at,
                triggered_by_id=None,
                source="backfill",
                event_type="created",
                task_id_snapshot=task.id,
                task_key_snapshot=task.key,
                project_id_snapshot=task.project_id,
                from_column_name=None,
                to_column_name=None,
                to_column_kind=None,
                to_column_is_done=False,
                assignee_ids=list(task.assignees.values_list("id", flat=True)),
            )
        )
    if creations:
        StateTransition.objects.bulk_create(creations, batch_size=500)


def remove_synthetic_creations(apps, schema_editor):
    StateTransition = apps.get_model("tasks", "StateTransition")
    StateTransition.objects.filter(event_type="created", source="backfill").delete()
    # The previous schema requires a live task FK with CASCADE semantics.
    # Events whose tasks were deleted after this migration cannot be
    # represented there, so discard them before AlterField restores NOT NULL.
    StateTransition.objects.filter(task_id__isnull=True).delete()


class Migration(migrations.Migration):
    dependencies = [("tasks", "0024_statetransition_assignee_ids")]

    operations = [
        migrations.AddField(
            model_name="statetransition",
            name="event_type",
            field=models.CharField(
                choices=[("created", "Created"), ("moved", "Moved")],
                default="moved",
                help_text=(
                    "Explicit event semantic. Creation must never be inferred from a "
                    "null from_column because Inbox tasks begin without a column."
                ),
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="from_column_name",
            field=models.CharField(blank=True, max_length=80, null=True),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="project_id_snapshot",
            field=models.PositiveBigIntegerField(
                blank=True,
                help_text="Immutable project id at the time of the event; null for Inbox.",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="task_id_snapshot",
            field=models.PositiveBigIntegerField(null=True),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="task_key_snapshot",
            field=models.CharField(max_length=32, null=True),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="to_column_is_done",
            field=models.BooleanField(
                default=False,
                help_text="Immutable completion status of the destination column.",
            ),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="to_column_kind",
            field=models.CharField(
                blank=True,
                choices=[
                    ("backlog", "Backlog"),
                    ("todo", "Todo"),
                    ("in_progress", "In progress"),
                    ("review", "Review"),
                    ("done", "Done"),
                    ("other", "Other"),
                ],
                help_text="Immutable semantic kind of the destination column.",
                max_length=16,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="statetransition",
            name="to_column_name",
            field=models.CharField(blank=True, max_length=80, null=True),
        ),
        migrations.AlterField(
            model_name="statetransition",
            name="task",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="transitions",
                to="tasks.task",
            ),
        ),
        migrations.RunPython(
            backfill_analytics_snapshots, remove_synthetic_creations
        ),
        migrations.AlterField(
            model_name="statetransition",
            name="task_id_snapshot",
            field=models.PositiveBigIntegerField(
                help_text=(
                    "Immutable task primary-key snapshot for durable distinct counts."
                )
            ),
        ),
        migrations.AlterField(
            model_name="statetransition",
            name="task_key_snapshot",
            field=models.CharField(
                help_text="Immutable human-readable task key snapshot.", max_length=32
            ),
        ),
        migrations.AddIndex(
            model_name="statetransition",
            index=models.Index(
                fields=["project_id_snapshot", "event_type", "at"],
                name="tasks_state_project_a12d18_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="statetransition",
            index=models.Index(
                fields=["project_id_snapshot", "to_column_kind", "at"],
                name="tasks_state_project_101f23_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="statetransition",
            index=models.Index(
                fields=["task_id_snapshot", "at"],
                name="tasks_state_task_id_4019af_idx",
            ),
        ),
    ]
