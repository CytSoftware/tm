from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import UserProfile


class GitHubMappingTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("mapper")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_save_normalize_read_and_clear(self):
        for value, expected in [(" @Octo-Cat ", "octo-cat"), ("", "")]:
            response = self.client.patch("/api/auth/me/", {"github_username": value}, format="json")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["github_username"], expected)
            self.assertEqual(self.client.get("/api/auth/me/").data["github_username"], expected)

    def test_invalid_and_duplicate_mapping_rejected(self):
        other = get_user_model().objects.create_user("other")
        profile, _ = UserProfile.objects.get_or_create(user=other)
        profile.github_username = "Octocat"
        profile.save()
        for value in [None, 123, "https://github.com/me", "a--b", "-foo", "foo-", "a" * 40, "OCTOCAT"]:
            response = self.client.patch("/api/auth/me/", {"github_username": value}, format="json")
            self.assertEqual(response.status_code, 400, value)
        self.assertEqual(UserProfile.objects.get(user=self.user).github_username, "")

    def test_cannot_change_another_user_or_write_anonymously(self):
        other = get_user_model().objects.create_user("other")
        self.client.patch("/api/auth/me/", {"id": other.id, "github_username": "octocat"}, format="json")
        self.assertEqual(UserProfile.objects.get(user=self.user).github_username, "octocat")
        self.assertFalse(UserProfile.objects.filter(user=other, github_username="octocat").exists())
        self.client.force_authenticate(None)
        self.assertEqual(self.client.patch("/api/auth/me/", {"github_username": "x"}, format="json").status_code, 401)
