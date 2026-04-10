"""Data migration: add a Backlog column to every existing project.

Shifts existing column `order` values up by 1 to make room at position 0,
then inserts a fresh Backlog column. Idempotent — projects that already
have a Backlog column are skipped.
"""

from django.db import migrations


def add_backlog_column(apps, schema_editor):
    Project = apps.get_model("tasks", "Project")
    Column = apps.get_model("tasks", "Column")

    for project in Project.objects.all():
        if project.columns.filter(name__iexact="Backlog").exists():
            continue
        # Shift every existing column up by 1. Do it in descending order to
        # avoid tripping the (project, order) unique constraint.
        existing = list(project.columns.order_by("-order"))
        for col in existing:
            col.order = col.order + 1
            col.save(update_fields=["order"])
        Column.objects.create(
            project=project,
            name="Backlog",
            order=0,
            is_done=False,
        )


def remove_backlog_column(apps, schema_editor):
    Column = apps.get_model("tasks", "Column")
    Column.objects.filter(name="Backlog", order=0).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("tasks", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(add_backlog_column, remove_backlog_column),
    ]
