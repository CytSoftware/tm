"""Drop the removed CRM (contacts) and pipelines modules.

Both apps were deleted from the codebase. Their tables are leaf nodes — no
other table has a foreign key pointing into them — so we can drop them
outright. Tables are dropped children-first so the DROPs are valid under
foreign-key enforcement (SQLite today, Postgres later). Their rows in
``django_migrations`` are removed too, so the migration state is fully clean
once the apps are gone.

Irreversible: the source apps no longer exist to recreate the schema.
"""

from django.db import migrations

# Child tables first, then their parents.
_DROP_TABLES = [
    "crm_contact_labels",       # m2m: contact <-> label
    "crm_contact",
    "crm_contactlabel",
    "crm_contactcounter",
    "pipelines_pipelineevent",  # -> pipeline
    "pipelines_pipeline",       # -> stage
    "pipelines_stage",
    "pipelines_pipelinecounter",
]

_DROP_SQL = "\n".join(f'DROP TABLE IF EXISTS "{t}";' for t in _DROP_TABLES)
_FORGET_MIGRATIONS = (
    "DELETE FROM django_migrations WHERE app IN ('crm', 'pipelines');"
)


class Migration(migrations.Migration):
    dependencies = [
        ("tasks", "0021_bet_task_bet_metric_checkin_and_more"),
    ]

    operations = [
        migrations.RunSQL(
            sql=_DROP_SQL + "\n" + _FORGET_MIGRATIONS,
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
