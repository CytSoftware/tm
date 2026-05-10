"""Seed the default contact labels and the singleton key counter.

Idempotent: ``get_or_create`` keys on the natural identity (label name,
counter SINGLETON_PK) so re-running on an already-seeded database is a
no-op.
"""

from django.db import migrations


DEFAULT_LABELS = [
    {"name": "Lead", "color": "#3b82f6"},
    {"name": "Prospect", "color": "#a855f7"},
    {"name": "Customer", "color": "#10b981"},
    {"name": "Contacted", "color": "#f59e0b"},
    {"name": "VIP", "color": "#ef4444"},
]


def seed_forward(apps, schema_editor):
    ContactLabel = apps.get_model("crm", "ContactLabel")
    ContactCounter = apps.get_model("crm", "ContactCounter")

    for spec in DEFAULT_LABELS:
        ContactLabel.objects.get_or_create(
            name=spec["name"],
            defaults={"color": spec["color"]},
        )

    ContactCounter.objects.get_or_create(pk=1, defaults={"value": 0})


def seed_reverse(apps, schema_editor):
    # Don't drop user data on rollback — let migrate handle the schema only.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("crm", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_forward, seed_reverse),
    ]
