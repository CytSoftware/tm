"""Stages are named after what happened (potential → outreach → in talks →
pilot/proposal → won/lost) and a lost lead carries a reason from a fixed list.

New leads with no update were never contacted, so they become potential; the
rest become outreach. Free-text lost reasons can't be mapped and are cleared.
"""

from django.db import migrations, models

STAGE_MAP = {
    "discovery": "in_talks",
    "demo": "in_talks",
    "pilot": "offer",
    "proposal": "offer",
}
REASONS = {"not_now", "no_response", "no_fit", "chose_other", "no_budget"}


def forwards(apps, schema_editor):
    Lead = apps.get_model("crm", "Lead")
    for old, new in STAGE_MAP.items():
        Lead.objects.filter(stage=old).update(stage=new)
    Lead.objects.filter(stage="new", updates__isnull=True).update(stage="potential")
    Lead.objects.filter(stage="new").update(stage="outreach")
    Lead.objects.exclude(lost_reason__in=REASONS).update(lost_reason="")


def backwards(apps, schema_editor):
    Lead = apps.get_model("crm", "Lead")
    for new, old in {"potential": "new", "outreach": "new", "in_talks": "discovery", "offer": "proposal"}.items():
        Lead.objects.filter(stage=new).update(stage=old)


class Migration(migrations.Migration):

    dependencies = [
        ("crm", "0005_drop_follow_ups"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
        migrations.AlterField(
            model_name="lead",
            name="stage",
            field=models.CharField(
                choices=[
                    ("potential", "Potential"),
                    ("outreach", "Outreach"),
                    ("in_talks", "In talks"),
                    ("offer", "Pilot / Proposal"),
                    ("won", "Won"),
                    ("lost", "Lost"),
                ],
                db_index=True,
                default="potential",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="lead",
            name="lost_reason",
            field=models.CharField(
                blank=True,
                choices=[
                    ("not_now", "Not now"),
                    ("no_response", "No response"),
                    ("no_fit", "No fit"),
                    ("chose_other", "Chose another tool"),
                    ("no_budget", "No budget"),
                ],
                default="",
                max_length=16,
            ),
        ),
    ]
