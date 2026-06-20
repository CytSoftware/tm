"""Seed the singleton ``DocCounter`` row.

Idempotent: ``get_or_create`` on the singleton PK, so re-running on an
already-seeded database is a no-op. Reverse is intentionally a no-op so a
rollback never drops the counter.
"""

from django.db import migrations


def seed_forward(apps, schema_editor):
    DocCounter = apps.get_model("wiki", "DocCounter")
    DocCounter.objects.get_or_create(pk=1, defaults={"value": 0})


def seed_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("wiki", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_forward, seed_reverse),
    ]
