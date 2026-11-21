from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import Project, Task


class TaskSearchRelevanceTests(TestCase):
    """⌘K palette: a number search lists the task with that number first."""

    def setUp(self):
        user = get_user_model().objects.create_user("search-user", is_staff=True)
        self.client = APIClient()
        self.client.force_authenticate(user)
        project = Project.objects.create(name="Mow", prefix="MOW")
        column = project.columns.first()

        def task(key, title, description=""):
            return Task.objects.create(
                project=project, column=column, reporter=user, key=key,
                title=title, description=description,
            )

        # Created first so default (project/column/position/id) order puts
        # the noise ahead of the real match — the bug in the palette.
        self.desc_hit = task("MOW-436", "Logins", "see ticket 457")
        self.title_hit = task("MOW-437", "Rage click 457 times")
        self.key_hit = task("MOW-457", "Drive: client links")

    def test_relevance_puts_key_match_first_then_title_then_description(self):
        res = self.client.get(
            "/api/tasks/", {"search": "457", "sort_field": "relevance", "limit": 10}
        )
        self.assertEqual(res.status_code, 200)
        keys = [t["key"] for t in res.json()["results"]]
        self.assertEqual(keys, ["MOW-457", "MOW-437", "MOW-436"])

    def test_relevance_without_search_is_harmless(self):
        res = self.client.get("/api/tasks/", {"sort_field": "relevance"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.json()["results"]), 3)
