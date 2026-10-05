from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("crm", "0002_seed_pipelines"),
        ("tasks", "0031_seed_waiting_column"),
    ]

    operations = [
        migrations.RenameField(model_name="deal", old_name="product_project", new_name="project"),
        migrations.AlterField(
            model_name="deal",
            name="project",
            field=models.ForeignKey(
                blank=True,
                help_text="Which of our businesses this deal is for (Mowafeq, Cyt…).",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="crm_deals",
                to="tasks.project",
            ),
        ),
    ]
