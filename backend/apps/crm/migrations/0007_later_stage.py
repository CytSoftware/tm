"""A "Later" stage for "not now": it was Lost with reason not_now, which hid
leads that said "not now" among the real no's."""

from django.db import migrations, models


def forwards(apps, schema_editor):
    Lead = apps.get_model("crm", "Lead")
    Lead.objects.filter(stage="lost", lost_reason="not_now").update(
        stage="later", lost_reason="", closed_at=None
    )


def backwards(apps, schema_editor):
    Lead = apps.get_model("crm", "Lead")
    Lead.objects.filter(stage="later").update(stage="lost", lost_reason="not_now")


class Migration(migrations.Migration):

    dependencies = [
        ("crm", "0006_event_stages"),
    ]

    operations = [
        migrations.AlterField(
            model_name="lead",
            name="stage",
            field=models.CharField(
                choices=[
                    ("potential", "Potential"),
                    ("outreach", "Outreach"),
                    ("in_talks", "In talks"),
                    ("offer", "Pilot / Proposal"),
                    ("later", "Later"),
                    ("won", "Won"),
                    ("lost", "Lost"),
                ],
                db_index=True,
                default="potential",
                max_length=16,
            ),
        ),
        migrations.RunPython(forwards, backwards),
        migrations.AlterField(
            model_name="lead",
            name="lost_reason",
            field=models.CharField(
                blank=True,
                choices=[
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
