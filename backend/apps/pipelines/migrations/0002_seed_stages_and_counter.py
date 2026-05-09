"""Seed default stages and the singleton key counter.

Idempotent: ``get_or_create`` keys on the natural identity (stage name +
order, counter SINGLETON_PK) so re-running the migration on an already-seeded
database is a no-op.
"""

from django.db import migrations


DEFAULT_STAGES = [
    {"name": "New", "order": 0, "color": "#94a3b8", "is_terminal": False},
    {"name": "In Progress", "order": 1, "color": "#3b82f6", "is_terminal": False},
    {"name": "Awaiting Response", "order": 2, "color": "#f59e0b", "is_terminal": False},
    {"name": "Action Required", "order": 3, "color": "#ef4444", "is_terminal": False},
    {"name": "Won", "order": 4, "color": "#10b981", "is_terminal": True},
    {"name": "Lost", "order": 5, "color": "#6b7280", "is_terminal": True},
]


def seed_forward(apps, schema_editor):
    Stage = apps.get_model("pipelines", "Stage")
    PipelineCounter = apps.get_model("pipelines", "PipelineCounter")

    for spec in DEFAULT_STAGES:
        Stage.objects.get_or_create(
            name=spec["name"],
            defaults={
                "order": spec["order"],
                "color": spec["color"],
                "is_terminal": spec["is_terminal"],
            },
        )

    PipelineCounter.objects.get_or_create(pk=1, defaults={"value": 0})


def seed_reverse(apps, schema_editor):
    # Don't drop user data on rollback — let migrate handle the schema only.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("pipelines", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_forward, seed_reverse),
    ]
