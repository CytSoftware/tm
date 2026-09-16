from django.test import TestCase
from apps.tasks.models import Project
from apps.integrations.models import ProjectRepository
from .tools import list_projects


class ProjectRepositoriesTest(TestCase):
    def test_mcp_exposes_all_explicit_repository_mappings(self):
        project = Project.objects.create(name="Project", prefix="MAP")
        for number in (1, 2):
            ProjectRepository.objects.create(project=project, repo_id=number, repo_full_name=f"CytSoftware/repo{number}")
        with self.assertNumQueries(2):
            result = list_projects()
        row = next(p for p in result if p["id"] == project.id)
        self.assertEqual({r["repo_id"] for r in row["repositories"]}, {1, 2})
        self.assertEqual({r["full_name"] for r in row["repositories"]}, {"CytSoftware/repo1", "CytSoftware/repo2"})
