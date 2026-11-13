"""Fill a development database with demo leads, licences and payments.

    DEBUG=1 uv run python manage.py seed_demo_crm

Dev-only, so the CRM board and the Billing / Licences tabs can be built and
eyeballed against data shaped like real deals: a yearly licence with a
renewal, a signed deal paid in instalments, a setup + retainer, one licence
about to expire and one that lapsed. Goes through ``services`` (the same path
REST and MCP use) and is idempotent.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.crm import services
from apps.crm.models import Lead, LeadStage, Licence, Payment
from apps.tasks.models import Project

# company → project prefix, product title,
#   leads:    [(lead title, stage)]
#   licences: [(starts, ends, lead index)]
#   payments: [(type, amount, due, paid, lead index, licence index or None)]
DEALS = {
    "Changda-CSMEDI JV": {
        "project": "MOW", "title": "Mowafeq licence",
        "leads": [("Mowafeq year 1", LeadStage.WON), ("Mowafeq renewal 2026", LeadStage.WON)],
        "licences": [(date(2025, 11, 2), date(2026, 11, 1), 0), (date(2026, 11, 2), date(2027, 11, 1), 1)],
        "payments": [
            ("licence", 60000, date(2025, 11, 2), date(2025, 11, 2), 0, 0),
            ("one_off", 15000, date(2025, 11, 2), date(2025, 11, 2), 0, None),
            ("licence", 60000, date(2026, 11, 2), date(2026, 10, 26), 1, 1),
        ],
    },
    "Abdullah Bin Eid Trading and Contracting": {
        "project": "MOW", "title": "Mowafeq Workspace",
        "leads": [("Mowafeq Workspace year 1", LeadStage.WON)],
        "licences": [(date(2026, 11, 7), date(2027, 11, 6), 0)],
        "payments": [
            ("down_payment", 10000, date(2026, 11, 7), date(2026, 11, 7), 0, 0),
            ("instalment", 10000, date(2026, 12, 5), None, 0, 0),
            ("instalment", 5000, date(2027, 5, 7), None, 0, 0),
        ],
    },
    "Shelter Group": {
        "project": "GEN", "title": "AI sales automation",
        "leads": [("AI sales automation", LeadStage.WON)],
        # The retainer's six-month minimum is the licence period.
        "licences": [(date(2026, 11, 1), date(2027, 4, 30), 0)],
        "payments": [
            ("down_payment", 60000, date(2026, 10, 1), None, 0, None),
            ("instalment", 60000, date(2026, 11, 30), None, 0, None),
            ("retainer", 10000, date(2026, 11, 1), None, 0, 0),
            ("retainer", 10000, date(2026, 12, 1), None, 0, 0),
            ("retainer", 10000, date(2027, 1, 1), None, 0, 0),
        ],
    },
    "Al Hattab Holding": {  # expiring, no renewal yet
        "project": "MOW", "title": "Mowafeq licence",
        "leads": [("Mowafeq pilot licence", LeadStage.WON)],
        "licences": [(date(2025, 12, 15), date(2026, 12, 14), 0)],
        "payments": [("licence", 30000, date(2025, 12, 15), date(2025, 12, 20), 0, 0)],
    },
    "Initech Health": {  # lapsed
        "project": "MOW", "title": "Mowafeq licence",
        "leads": [("Document control pilot licence", LeadStage.WON)],
        "licences": [(date(2025, 9, 1), date(2026, 8, 31), 0)],
        "payments": [("licence", 20000, date(2025, 9, 1), date(2025, 9, 10), 0, 0)],
    },
    "Mdcon Engineering Consultancy": {
        "project": "MOW", "title": "Mowafeq Workspace",
        "leads": [("Mowafeq Workspace", LeadStage.OFFER)], "licences": [], "payments": [],
    },
}


class Command(BaseCommand):
    help = "Seed demo CRM leads, licences and payments (DEBUG only)."

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("Refusing to seed demo data with DEBUG off.")
        counts = {"leads": 0, "licences": 0, "payments": 0}
        for company_name, deal in DEALS.items():
            company, _ = services.create_contact({"kind": "company", "name": company_name})
            project = Project.objects.filter(prefix=deal["project"]).first() or Project.objects.first()
            title = deal["title"]

            leads = []
            for lead_title, stage in deal["leads"]:
                lead = Lead.objects.filter(company=company, title=lead_title).first()
                if lead is None:
                    lead = services.create_lead(
                        {"title": lead_title, "company": company, "project": project, "stage": stage}, user=None
                    )
                    counts["leads"] += 1
                leads.append(lead)

            licences = []
            for starts, ends, li in deal["licences"]:
                lc = Licence.objects.filter(company=company, title=title, starts_on=starts).first()
                if lc is None:
                    lc = services.save_licence(None, {
                        "title": title, "company": company, "project": project,
                        "starts_on": starts, "ends_on": ends, "lead": leads[li],
                    })
                    counts["licences"] += 1
                licences.append(lc)

            for type_, amount, due, paid, li, lci in deal["payments"]:
                fields = {"lead": leads[li], "licence": licences[lci] if lci is not None else None}
                existing = Payment.objects.filter(company=company, title=title, type=type_, due_on=due).first()
                if existing is not None:
                    services.save_payment(existing, fields)
                    continue
                services.save_payment(None, {
                    "title": title, "company": company, "project": project, "type": type_,
                    "amount": Decimal(amount), "due_on": due, "paid_on": paid, **fields,
                })
                counts["payments"] += 1
        self.stdout.write(self.style.SUCCESS(
            "Seeded {leads} leads, {licences} licences and {payments} payments.".format(**counts)
        ))
