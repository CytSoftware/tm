from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tasks", "0026_task_reviewer_userprofile_github_username"),
    ]

    operations = [
        migrations.AddField(
            model_name="userprofile",
            name="quick_actions",
            field=models.JSONField(
                blank=True,
                default=list,
                help_text=(
                    "Ordered personal sidebar shortcuts. Each action opens an "
                    "app/external page, a project board, or an all-projects board "
                    "filtered to one user."
                ),
            ),
        ),
    ]
