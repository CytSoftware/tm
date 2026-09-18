"""Fill a development database with a believable web of meetings.

    uv run python manage.py seed_demo_meetings

Dev-only: it exists so the /meetings views (graph clusters, timeline lanes,
related panel) can be built and eyeballed against something shaped like real
data. Goes through ``services.upsert_meeting`` — the same path the pipeline
uses — and is idempotent (stems are fixed).
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.meetings import services
from apps.meetings.models import Meeting, MeetingLink
from apps.meetings.serializers import MeetingUpsertSerializer
from apps.tasks.models import Project

COMPANIES = {
    "Acme Logistics": ["Ali Khoury", "Dana Haddad", "Omar Nassar"],
    "Globex Retail": ["Sara Mansour", "Karim Aziz"],
    "Initech Health": ["Lina Saab", "Rami Fares", "Maya Tannous"],
    "Umbrella Capital": ["Nadim Rahme"],
}
TEAM = ["Chris Akoury", "Ali Soukarieh", "Abed Itani"]
TOPICS = ["pricing", "onboarding", "integration", "roadmap", "renewal", "security"]

# (title template, category, uses a company?)
KINDS = [
    ("{co} — discovery call", "sales", True),
    ("{co} — pricing walkthrough", "sales", True),
    ("{co} — weekly check-in", "client", True),
    ("{co} — integration workshop", "client", True),
    ("{co} — QBR", "client", True),
    ("Pitch feedback with {co}", "pitch_feedback", True),
    ("Weekly team sync", "internal", False),
    ("Roadmap planning", "internal", False),
    ("Interview — senior engineer", "interview", False),
]


class Command(BaseCommand):
    help = "Seed demo meetings for local development."

    def add_arguments(self, parser):
        parser.add_argument("--count", type=int, default=34)

    def handle(self, *args, count: int, **options):
        if not settings.DEBUG:
            raise CommandError("Refusing to seed demo data with DEBUG off.")
        rng = random.Random(7)
        projects = list(Project.objects.all()[:3])
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        made: dict[str, list[Meeting]] = {}

        for i in range(count):
            title_tpl, category, with_company = rng.choice(KINDS)
            company = rng.choice(list(COMPANIES)) if with_company else None
            started = now - timedelta(days=rng.randint(1, 200), hours=rng.randint(0, 8))
            team = rng.sample(TEAM, rng.randint(1, 2))
            entities = [{"kind": "person", "name": n, "company": "Cyt Software"} for n in team]
            if company:
                entities.append({"kind": "company", "name": company})
                for person in rng.sample(COMPANIES[company], rng.randint(1, len(COMPANIES[company]))):
                    entities.append({"kind": "person", "name": person, "company": company})
                other = rng.choice([c for c in COMPANIES if c != company])
                if rng.random() < 0.3:
                    entities.append({"kind": "company", "name": other, "role": "mentioned"})
            topics = rng.sample(TOPICS, 2)
            people = [e["name"] for e in entities if e["kind"] == "person"]
            speaker = people[-1]
            data = {
                "stem": f"demo-{i:03d}",
                "title": title_tpl.format(co=company),
                "started_at": started.isoformat(),
                "duration_seconds": rng.randint(15, 75) * 60,
                "language": rng.choice(["en", "en", "ar", "mixed"]),
                "speaker_count": len(entities),
                "category": category,
                "summary": f"Covered {topics[0]} and {topics[1]}; agreed next steps.",
                "brief_md": (
                    f"## Summary\nWe covered **{topics[0]}** and **{topics[1]}**.\n\n"
                    "## Decisions\n- Move ahead with the pilot\n- Revisit scope in two weeks\n\n"
                    "## Risks\n- Timeline depends on their IT sign-off\n"
                ),
                "transcript_md": "\n\n".join(
                    [
                        f"**{team[0]}:** Thanks for making the time. Let's start with {topics[0]}.",
                        f"**{speaker}:** Sure. Our main concern is {topics[1]} before we commit.",
                        f"**{team[0]}:** Understood — we can share the {topics[1]} plan this week.",
                        f"**{speaker}:** That works. Let's regroup once the team has reviewed it.",
                    ]
                ),
                "gshr_url": f"https://demo-{i:03d}.gshr.page",
                "tags": topics,
                "entities": entities,
                "action_items": [
                    {"text": f"Send the {topics[1]} plan", "owner": team[0]},
                    {"text": "Schedule the follow-up", "owner": team[-1]},
                ],
            }
            if projects and company:
                data["project"] = projects[list(COMPANIES).index(company) % len(projects)].prefix
            payload = MeetingUpsertSerializer(data=data)
            payload.is_valid(raise_exception=True)
            meeting, _ = services.upsert_meeting(payload.validated_data)
            if company:
                made.setdefault(company, []).append(meeting)

        # A few explicit follow-up chains within a company.
        for meetings in made.values():
            ordered = sorted(meetings, key=lambda m: m.started_at)
            for a, b in list(zip(ordered, ordered[1:]))[:2]:
                MeetingLink.objects.get_or_create(
                    from_meeting=b, to_meeting=a, defaults={"kind": "follow_up"}
                )
        self.stdout.write(self.style.SUCCESS(f"Seeded {count} demo meetings."))
