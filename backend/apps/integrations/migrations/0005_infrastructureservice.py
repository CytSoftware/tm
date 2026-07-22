import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("integrations", "0004_eventsource_page_configuration"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="InfrastructureService",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("name", models.CharField(max_length=120)),
                ("url", models.URLField(max_length=1000)),
                ("category", models.CharField(max_length=80)),
                (
                    "description",
                    models.CharField(blank=True, default="", max_length=300),
                ),
                (
                    "logo",
                    models.ImageField(
                        blank=True, null=True, upload_to="service-logos/"
                    ),
                ),
                ("position", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="infrastructure_services_created",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["category", "position", "name", "id"],
                "indexes": [
                    models.Index(
                        fields=["category", "position"],
                        name="infra_service_cat_pos_idx",
                    )
                ],
            },
        ),
    ]
