"""Give every existing project the new default "Waiting" column.

"Waiting" is where the ball is in someone else's court. It ships as a default
column (see ``DEFAULT_COLUMNS``), so projects created before this migration
need it backfilled or their boards would differ from new ones.

Forward only. The reverse is a no-op **on purpose**: ``Task.column`` is
``on_delete=CASCADE``, so dropping the column a user has since filled would
delete their tasks with it. Choices are validated in Python, not by SQLite, so
leaving the rows in place does not break a rollback.
"""

from django.db import migrations
from django.db.models import F

WAITING_THRESHOLD = {"yellow_days": 3, "red_days": 7}


def seed_waiting_column(apps, schema_editor):
    Project = apps.get_model("tasks", "Project")
    Column = apps.get_model("tasks", "Column")

    for project in Project.objects.all():
        columns = list(project.columns.order_by("order"))
        # (project, name) is unique, and re-running must be safe.
        if any(
            c.kind == "waiting" or c.name.strip().lower() == "waiting"
            for c in columns
        ):
            continue

        # Slot it right after active work, or at the end if this project has
        # renamed its way out of an in_progress column.
        insert_at = len(columns)
        for index, column in enumerate(columns):
            if column.kind == "in_progress":
                insert_at = index + 1

        if columns:
            # Two-phase reassignment, same as ColumnViewSet.reorder: park every
            # row in a disjoint range first so (project, order) can't collide
            # mid-update.
            offset = max(c.order for c in columns) + 1000
            Column.objects.filter(project=project).update(order=F("order") + offset)
            tail = columns[insert_at:]
            for index, column in enumerate(columns[:insert_at]):
                Column.objects.filter(pk=column.pk).update(order=index)
            for index, column in enumerate(tail, start=insert_at + 1):
                Column.objects.filter(pk=column.pk).update(order=index)

        Column.objects.create(
            project=project,
            name="Waiting",
            order=insert_at,
            kind="waiting",
            is_done=False,
        )


def seed_waiting_threshold(apps, schema_editor):
    StaleThresholdConfig = apps.get_model("tasks", "StaleThresholdConfig")
    config = StaleThresholdConfig.objects.filter(pk=1).first()
    # No row yet means the singleton will be created from the model defaults,
    # which already carry "Waiting".
    if config is None or "Waiting" in config.thresholds:
        return
    config.thresholds["Waiting"] = dict(WAITING_THRESHOLD)
    config.save(update_fields=["thresholds"])


class Migration(migrations.Migration):
    dependencies = [
        ("tasks", "0030_alter_column_kind_and_more"),
    ]

    operations = [
        migrations.RunPython(seed_waiting_column, migrations.RunPython.noop),
        migrations.RunPython(seed_waiting_threshold, migrations.RunPython.noop),
    ]
