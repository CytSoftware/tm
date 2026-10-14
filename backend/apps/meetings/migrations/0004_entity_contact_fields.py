from django.db import migrations, models


class Migration(migrations.Migration):
    """The CRM no longer flags entities: relationship, owner, WhatsApp and the
    project tags go; headline becomes a person's position."""

    dependencies = [
        ("meetings", "0003_entity_projects"),
        # crm/0004 reads ``relationship`` / ``projects`` before they go.
        ("crm", "0004_leads"),
    ]

    operations = [
        migrations.RemoveField("entity", "relationship"),
        migrations.RemoveField("entity", "owner"),
        migrations.RemoveField("entity", "whatsapp"),
        migrations.RemoveField("entity", "projects"),
        migrations.RenameField("entity", "headline", "position"),
        migrations.AlterField(
            model_name="entity",
            name="position",
            field=models.CharField(
                blank=True,
                default="",
                help_text="A person's role, e.g. 'Regional Director of BIM'. The company is ``company``.",
                max_length=200,
            ),
        ),
    ]
