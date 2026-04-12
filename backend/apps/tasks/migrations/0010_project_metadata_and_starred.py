# Renumbered from 0007 to 0010 after merging main (which added 0007-0009).
# The `color` field was already added to Project in 0007_multiassignee_priority_color_projectless,
# so we only add description, icon, archived, and starred_projects here.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tasks', '0009_profile_image'),
    ]

    operations = [
        migrations.AddField(
            model_name='project',
            name='archived',
            field=models.BooleanField(default=False, help_text='Archived projects are hidden from the default sidebar list.'),
        ),
        migrations.AddField(
            model_name='project',
            name='description',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='project',
            name='icon',
            field=models.CharField(blank=True, default='', help_text='Single emoji or short string shown next to the project name.', max_length=8),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='starred_projects',
            field=models.ManyToManyField(blank=True, help_text='Projects this user has pinned to the top of their sidebar.', related_name='starred_by', to='tasks.project'),
        ),
    ]
