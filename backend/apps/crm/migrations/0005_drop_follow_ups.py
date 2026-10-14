"""Follow-ups go: crm/0004 already turned each into the update that filed its
task. The tasks stay where they are (the FUP project); only the join rows and
the pipeline tables are dropped."""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("crm", "0004_leads"),
    ]

    operations = [
        migrations.DeleteModel("FollowUp"),
        migrations.DeleteModel("CrmSettings"),
        migrations.DeleteModel("Stage"),
        migrations.DeleteModel("Pipeline"),
    ]
