from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import Column, Project, Task


class SharedBoardTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("board-user")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.project = Project.objects.create(name="One", prefix="ONE")
        self.other = Project.objects.create(name="Two", prefix="TWO")
        self.dev = Column.objects.create(project=self.project, name="In Dev", kind="in_progress", order=8)
        self.testing = Column.objects.create(project=self.project, name="Testing", kind="in_progress", order=9)
        self.special = Column.objects.create(project=self.other, name="Waiting on vendor", kind="other", order=8)
        self.doing = self.other.columns.get(kind="in_progress")
        self.a = self.task(self.dev, 1000)
        self.b = self.task(self.testing, 2000)
        self.c = self.task(self.doing, 3000)
        self.d = self.task(self.special, 1500)

    def task(self, column, position):
        task = Task.objects.create(project=column.project, column=column, reporter=self.user, title=column.name)
        Task.objects.filter(pk=task.pk).update(position=position)
        task.refresh_from_db()
        return task

    def move(self, column, **kwargs):
        return self.client.post(f"/api/tasks/{self.a.key}/move/", {"column_id": column.id, **kwargs}, format="json")

    def test_stage_queries_include_custom_names_and_other(self):
        response = self.client.get("/api/tasks/?column_kind=in_progress")
        self.assertEqual({t["id"] for t in response.data["results"]}, {self.a.id, self.b.id, self.c.id})
        response = self.client.get("/api/tasks/?column_kind=other")
        self.assertEqual([t["id"] for t in response.data["results"]], [self.d.id])
        response = self.client.get("/api/tasks/?column_kind=in_progress&column=Testing")
        self.assertEqual([t["id"] for t in response.data["results"]], [self.b.id])

    def test_shared_stage_reorder_preserves_real_column(self):
        response = self.move(self.dev, position_scope="kind", after_id=self.b.id)
        self.assertEqual(response.status_code, 200, response.data)
        self.a.refresh_from_db()
        self.assertEqual(self.a.column_id, self.dev.id)
        self.assertEqual(self.a.position, 2500)
        self.assertFalse(self.a.transitions.exists())

    def test_project_reorder_uses_only_real_column(self):
        neighbor = self.task(self.dev, 100)
        response = self.move(self.dev, after_id=neighbor.id)
        self.assertEqual(response.status_code, 200)
        self.a.refresh_from_db()
        self.assertEqual(self.a.position, 1100)

    def test_wrong_stage_or_project_is_rejected_without_changes(self):
        for column, args in [(self.dev, {"position_scope": "kind", "after_id": self.d.id}),
                             (self.dev, {"after_id": self.b.id}),
                             (self.doing, {})]:
            self.assertEqual(self.move(column, **args).status_code, 400)
        self.a.refresh_from_db()
        self.assertEqual(self.a.column_id, self.dev.id)
        self.assertEqual(self.a.position, 1000)

    def test_tied_cross_project_neighbors_get_distinct_positions(self):
        Task.objects.filter(pk__in=[self.b.id, self.c.id]).update(position=1000)
        response = self.move(self.dev, position_scope="kind", after_id=self.b.id, before_id=self.c.id)
        self.assertEqual(response.status_code, 200)
        for task in [self.a, self.b, self.c]:
            task.refresh_from_db()
        self.assertLess(self.b.position, self.a.position)
        self.assertLess(self.a.position, self.c.position)
