# Hand-written initial migration for the pipelines app. Mirrors what
# `makemigrations pipelines` produces for the models in apps/pipelines/models.py.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Stage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('name', models.CharField(max_length=80, unique=True)),
                ('order', models.PositiveSmallIntegerField(unique=True)),
                ('color', models.CharField(default='#6366f1', help_text='CSS hex color used to badge the stage in the UI.', max_length=9)),
                ('is_terminal', models.BooleanField(default=False, help_text='Marks an end-state stage (Won / Lost). UI may grey out.')),
            ],
            options={
                'ordering': ['order'],
            },
        ),
        migrations.CreateModel(
            name='PipelineCounter',
            fields=[
                ('id', models.PositiveSmallIntegerField(default=1, primary_key=True, serialize=False)),
                ('value', models.PositiveIntegerField(default=0)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
        ),
        migrations.CreateModel(
            name='Pipeline',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('key', models.CharField(blank=True, editable=False, max_length=32, unique=True)),
                ('title', models.CharField(max_length=300)),
                ('description', models.TextField(blank=True, default='', help_text='Free-text background. Day-to-day detail belongs in events.')),
                ('counterparty', models.CharField(blank=True, default='', help_text="External party we're dealing with (bank name, vendor, etc.).", max_length=200)),
                ('position', models.FloatField(default=1000.0, help_text='Sort order within a stage. Midpoint insertion strategy.')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='created_pipelines', to=settings.AUTH_USER_MODEL)),
                ('owner', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='owned_pipelines', to=settings.AUTH_USER_MODEL)),
                ('stage', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='pipelines', to='pipelines.stage')),
            ],
            options={
                'ordering': ['stage_id', 'position', 'id'],
                'indexes': [models.Index(fields=['stage', 'position'], name='pipelines_p_stage_i_2c6b69_idx')],
            },
        ),
        migrations.CreateModel(
            name='PipelineEvent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('body', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('author', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='pipeline_events', to=settings.AUTH_USER_MODEL)),
                ('pipeline', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='events', to='pipelines.pipeline')),
            ],
            options={
                'ordering': ['pipeline_id', 'created_at', 'id'],
                'indexes': [models.Index(fields=['pipeline', 'created_at'], name='pipelines_p_pipelin_4e3c1a_idx')],
            },
        ),
    ]
