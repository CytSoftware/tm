"""Deals → leads, touchpoints → updates (docs/plans/crm.md).

Renames in place so existing rows survive: a deal keeps its ``DEAL-…`` key and
its stage maps onto the fixed board by name (won/lost by kind; anything else
lands in ``new``). Dropped outright: pipelines, owner, currency, expected
close, value, deal contacts, and touchpoint direction/source/external id.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

FIXED = {"new", "discovery", "demo", "pilot", "proposal"}
KINDS = {"whatsapp": "message", "calendar": "meeting", "other": "note"}


def map_stages(apps, schema_editor):
    Lead = apps.get_model("crm", "Lead")
    for lead in Lead.objects.select_related("old_stage"):
        old = lead.old_stage
        if old.kind in ("won", "lost"):
            lead.stage = old.kind
        else:
            name = old.name.strip().lower()
            lead.stage = name if name in FIXED else "new"
        lead.save(update_fields=["stage"])


def map_kinds(apps, schema_editor):
    Update = apps.get_model("crm", "Update")
    for old, new in KINDS.items():
        Update.objects.filter(kind=old).update(kind=new)


LABELS = {"client": "client", "lead": "lead", "partner": "partner",
          "advisor": "advisor", "investor": "investor", "other": "contact"}


def carry_over(apps, schema_editor):
    """What a plain rename would lose. Runs before crm/0005 drops follow-ups
    and meetings/0004 drops ``relationship`` — it reads both.

    1. "Our side" on old touchpoints = whoever logged them.
    2. Each follow-up becomes the update that filed it, so an open one is
       its lead's next step again.
    3. A ``lead`` company with no deal becomes a New lead (it was a prospect).
    4. Anyone else who was in the CRM gets one backdated note naming their old
       relationship, so they stay listed without a fake lead on the board.
    """
    Update = apps.get_model("crm", "Update")
    Lead = apps.get_model("crm", "Lead")
    LeadCounter = apps.get_model("crm", "LeadCounter")
    FollowUp = apps.get_model("crm", "FollowUp")
    Entity = apps.get_model("meetings", "Entity")

    for u in Update.objects.exclude(created_by=None):
        u.users.add(u.created_by_id)

    for f in FollowUp.objects.select_related("task"):
        task = f.task
        u = Update.objects.create(
            lead_id=f.deal_id,
            kind="note",
            body=f"Follow-up: {task.title}",
            occurred_at=task.created_at,
            task_id=task.id,
            created_by_id=task.reporter_id,
        )
        u.people.add(f.entity_id)
        u.users.add(*task.assignees.values_list("id", flat=True))

    # Historical models skip Lead.save(), so keys come from the counter here.
    counter, _ = LeadCounter.objects.get_or_create(pk=1)
    position = (Lead.objects.filter(stage="new").order_by("-position").values_list("position", flat=True).first() or 0)
    prospects = Entity.objects.filter(kind="company", relationship="lead", leads__isnull=True)
    for company in prospects.order_by("name"):
        counter.value += 1
        position += 1000
        projects = list(company.projects.values_list("id", flat=True))
        Lead.objects.create(
            key=f"LEAD-{counter.value:03d}",
            title=company.name,
            company=company,
            project_id=projects[0] if len(projects) == 1 else None,
            stage="new",
            position=position,
        )
    counter.save()

    listed = (
        Entity.objects.filter(leads__isnull=False)
        | Entity.objects.filter(crm_updates__isnull=False)
        | Entity.objects.filter(company__leads__isnull=False)
    ).values("id")
    for e in Entity.objects.filter(relationship__in=LABELS).exclude(id__in=listed):
        u = Update.objects.create(
            kind="note",
            body=f"Carried over from the old CRM: {LABELS[e.relationship]}.",
            occurred_at=e.created_at,
        )
        u.people.add(e.id)
        if e.owner_id:
            u.users.add(e.owner_id)


class Migration(migrations.Migration):

    dependencies = [
        ("crm", "0003_rename_deal_project"),
        ("meetings", "0003_entity_projects"),
        ("tasks", "0034_push_subscription"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # -- Deal → Lead -------------------------------------------------------
        migrations.RenameModel("Deal", "Lead"),
        migrations.RenameModel("DealCounter", "LeadCounter"),
        migrations.RenameField("lead", "stage", "old_stage"),
        migrations.AddField(
            model_name="lead",
            name="stage",
            field=models.CharField(
                choices=[
                    ("new", "New"),
                    ("discovery", "Discovery"),
                    ("demo", "Demo"),
                    ("pilot", "Pilot"),
                    ("proposal", "Proposal"),
                    ("won", "Won"),
                    ("lost", "Lost"),
                ],
                db_index=True,
                default="new",
                max_length=16,
            ),
        ),
        migrations.RunPython(map_stages, migrations.RunPython.noop),
        migrations.RemoveField("lead", "old_stage"),
        migrations.RemoveField("lead", "pipeline"),
        migrations.RemoveField("lead", "owner"),
        migrations.RemoveField("lead", "currency"),
        migrations.RemoveField("lead", "expected_close"),
        migrations.RemoveField("lead", "contacts"),
        migrations.AlterField(
            model_name="lead",
            name="company",
            field=models.ForeignKey(
                blank=True,
                limit_choices_to={"kind": "company"},
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="leads",
                to="meetings.entity",
            ),
        ),
        migrations.AlterField(
            model_name="lead",
            name="project",
            field=models.ForeignKey(
                blank=True,
                help_text="Which of our businesses this lead is for (Mowafeq, Cyt…).",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="crm_leads",
                to="tasks.project",
            ),
        ),
        migrations.AlterField(
            model_name="lead",
            name="created_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="created_leads",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RemoveField("lead", "value"),
        migrations.AlterField(
            model_name="lead",
            name="notes",
            field=models.TextField(
                blank=True,
                default="",
                help_text="Standing context; what happened goes in updates.",
            ),
        ),
        # -- Touchpoint → Update -------------------------------------------------
        migrations.RemoveConstraint("touchpoint", "touchpoint_unique_external_id"),
        migrations.RenameModel("Touchpoint", "Update"),
        migrations.RenameField("update", "summary", "body"),
        migrations.RenameField("update", "entities", "people"),
        migrations.RenameField("update", "deal", "lead"),
        migrations.RemoveField("update", "direction"),
        migrations.RemoveField("update", "source"),
        migrations.RemoveField("update", "external_id"),
        migrations.RunPython(map_kinds, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="update",
            name="kind",
            field=models.CharField(
                choices=[
                    ("note", "Note"),
                    ("message", "Message"),
                    ("call", "Call"),
                    ("email", "Email"),
                    ("meeting", "Meeting"),
                ],
                default="note",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="update",
            name="lead",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="updates",
                to="crm.lead",
            ),
        ),
        migrations.AlterField(
            model_name="update",
            name="people",
            field=models.ManyToManyField(
                blank=True, related_name="crm_updates", to="meetings.entity"
            ),
        ),
        migrations.AlterField(
            model_name="update",
            name="created_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="created_crm_updates",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="update",
            name="task",
            field=models.OneToOneField(
                blank=True,
                help_text="What they need next, filed by this update.",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="crm_update",
                to="tasks.task",
            ),
        ),
        migrations.AddField(
            model_name="update",
            name="users",
            field=models.ManyToManyField(
                blank=True,
                help_text="Who from our side was on it.",
                related_name="crm_updates",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="update",
            name="meeting",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="crm_updates",
                to="meetings.meeting",
            ),
        ),
        migrations.RunPython(carry_over, migrations.RunPython.noop),
    ]
