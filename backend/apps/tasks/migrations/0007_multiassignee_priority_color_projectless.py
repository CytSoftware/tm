"""0007 — multi-assignee + P1..P4 priorities + project color + projectless tasks.

This migration reshapes four things at once because the changes overlap in
the same tables:

1. ``Task.assignee`` (FK) → ``Task.assignees`` (M2M). Same for
   ``RecurringTaskTemplate``. Existing FK values are copied into the M2M
   before the FK is dropped.
2. Priority values renamed ``LOW/MEDIUM/HIGH/URGENT`` → ``P4/P3/P2/P1``.
   Data rewrite runs before the ``AlterField`` that declares the new choices
   (choices aren't enforced at the DB level, so row writes still succeed —
   but we keep the ordering clean for readability).
3. ``Project.color`` added; existing rows are backfilled from a deterministic
   palette so every project has a color without requiring user action.
4. ``Task.project`` and ``Task.column`` become nullable so tasks can live in
   an "Inbox" with no project. No data rewrite needed for this one.

Reverse migration is deliberately not supported — downgrading to the single
-assignee FK would lose information when a task has more than one assignee.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


# Keep in sync with `frontend/src/lib/colors.ts::PROJECT_COLOR_PALETTE`.
# Used to backfill Project.color on existing rows and as the seed palette
# for the create-project dialog.
PROJECT_COLOR_PALETTE = [
    "#6366f1",  # indigo
    "#ec4899",  # pink
    "#10b981",  # emerald
    "#f59e0b",  # amber
    "#ef4444",  # red
    "#06b6d4",  # cyan
    "#8b5cf6",  # violet
    "#14b8a6",  # teal
    "#f97316",  # orange
    "#84cc16",  # lime
]


PRIORITY_RENAMES = [
    ("LOW", "P4"),
    ("MEDIUM", "P3"),
    ("HIGH", "P2"),
    ("URGENT", "P1"),
]


def forwards(apps, schema_editor):
    Task = apps.get_model("tasks", "Task")
    RecurringTaskTemplate = apps.get_model("tasks", "RecurringTaskTemplate")
    Project = apps.get_model("tasks", "Project")

    # 1. Copy Task.assignee_id → Task.assignees M2M for every row that had one.
    for task in Task.objects.exclude(assignee__isnull=True).only("id", "assignee_id"):
        task.assignees.add(task.assignee_id)

    for tpl in RecurringTaskTemplate.objects.exclude(
        assignee__isnull=True
    ).only("id", "assignee_id"):
        tpl.assignees.add(tpl.assignee_id)

    # 2. Rename priority values on both tables. Uses bulk .update() so it
    # stays one query per value, no Python-side row shuttling.
    for old, new in PRIORITY_RENAMES:
        Task.objects.filter(priority=old).update(priority=new)
        RecurringTaskTemplate.objects.filter(priority=old).update(priority=new)

    # 3. Backfill Project.color for existing rows. The default "#6366f1" was
    # applied to every row by the AddField step; swap in a deterministic
    # palette entry so different projects are visually distinct on day 1.
    for project in Project.objects.all().only("id", "color"):
        project.color = PROJECT_COLOR_PALETTE[project.id % len(PROJECT_COLOR_PALETTE)]
        project.save(update_fields=["color"])


class Migration(migrations.Migration):

    dependencies = [
        ('tasks', '0006_alter_recurringtasktemplate_column_alter_task_column'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # --- Drop the old (project, assignee) index now so the Task.assignee
        # removal at the end of this migration doesn't trip over it.
        migrations.RemoveIndex(
            model_name='task',
            name='tasks_task_project_5e8812_idx',
        ),

        # --- Add the new structural fields before we try to populate them.
        migrations.AddField(
            model_name='project',
            name='color',
            field=models.CharField(
                default='#6366f1',
                help_text='CSS hex color used to badge the project in cards and pickers.',
                max_length=9,
            ),
        ),
        migrations.AddField(
            model_name='recurringtasktemplate',
            name='assignees',
            field=models.ManyToManyField(
                blank=True,
                related_name='assigned_recurring_templates',
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name='task',
            name='assignees',
            field=models.ManyToManyField(
                blank=True,
                related_name='assigned_tasks',
                to=settings.AUTH_USER_MODEL,
            ),
        ),

        # --- Relax project/column to nullable so Inbox tasks are legal.
        migrations.AlterField(
            model_name='task',
            name='column',
            field=models.ForeignKey(
                blank=True,
                help_text='Null for projectless tasks.',
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='tasks',
                to='tasks.column',
            ),
        ),
        migrations.AlterField(
            model_name='task',
            name='project',
            field=models.ForeignKey(
                blank=True,
                help_text="Null means the task lives in the 'Inbox' (no project).",
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='tasks',
                to='tasks.project',
            ),
        ),

        # --- Data migration: copy FK → M2M, rename priorities, palette colors.
        migrations.RunPython(forwards, migrations.RunPython.noop),

        # --- Swap the priority choices over to P1..P4 (metadata only; the
        # DB column is still CharField max_length=8).
        migrations.AlterField(
            model_name='recurringtasktemplate',
            name='priority',
            field=models.CharField(
                choices=[('P1', 'P1'), ('P2', 'P2'), ('P3', 'P3'), ('P4', 'P4')],
                default='P3',
                max_length=8,
            ),
        ),
        migrations.AlterField(
            model_name='task',
            name='priority',
            field=models.CharField(
                choices=[('P1', 'P1'), ('P2', 'P2'), ('P3', 'P3'), ('P4', 'P4')],
                default='P3',
                max_length=8,
            ),
        ),

        # --- Drop the old FK fields now that the M2M is populated.
        migrations.RemoveField(
            model_name='recurringtasktemplate',
            name='assignee',
        ),
        migrations.RemoveField(
            model_name='task',
            name='assignee',
        ),
    ]
