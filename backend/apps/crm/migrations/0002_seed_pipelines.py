"""Seed the two pipelines Chris asked for (docs/plans/crm.md).

Idempotent on ``slug``, and the reverse is a no-op on purpose: pipelines can
be edited after seeding and deals hold PROTECT FKs to them.
"""

from django.db import migrations

PIPELINES = [
    (
        "Sales",
        "sales",
        [
            ("Discovery", "open"),
            ("Demo", "open"),
            ("Pilot", "open"),
            ("Proposal", "open"),
            ("Won", "won"),
            ("Lost", "lost"),
        ],
    ),
    (
        "Fundraising & Programs",
        "fundraising",
        [
            ("Identified", "open"),
            ("Applied", "open"),
            ("In process", "open"),
            ("Accepted", "won"),
            ("Rejected", "lost"),
        ],
    ),
]


def seed(apps, schema_editor):
    Pipeline = apps.get_model("crm", "Pipeline")
    Stage = apps.get_model("crm", "Stage")
    for position, (name, slug, stages) in enumerate(PIPELINES):
        pipeline, created = Pipeline.objects.get_or_create(
            slug=slug, defaults={"name": name, "position": float(position)}
        )
        if not created:
            continue
        for index, (stage_name, kind) in enumerate(stages):
            Stage.objects.create(
                pipeline=pipeline, name=stage_name, kind=kind, position=float(index)
            )


class Migration(migrations.Migration):
    dependencies = [("crm", "0001_initial")]

    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
