"""Access metadata for the Drive and the LLM wiki.

B2 still holds every byte and stays the source of truth for *what exists*.
These rows only decide *who else may see it*: staff see everything, and a
non-staff user sees nothing in either until a row grants it (see
``apps.tasks.access``). Both are edited in the Django admin for now.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class DriveFile(models.Model):
    """One Drive object a non-staff user can reach: they uploaded it, or it
    was shared with them. Objects with no row are staff-only."""

    key = models.CharField(max_length=1024, unique=True, help_text="Drive path as shown in the Drive, e.g. 'docs/spec.pdf'.")
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="uploaded_drive_files",
    )
    shared_with = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="shared_drive_files"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["key"]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return self.key


class KnowledgePageProject(models.Model):
    """Files an LLM-wiki page under a project. A page with no row is
    staff-only; a page under several projects needs membership of all of
    them, because one synthesized page mixes facts from each."""

    slug = models.CharField(max_length=512, help_text="Page slug, e.g. 'entities/companies/egis'.")
    project = models.ForeignKey(
        "tasks.Project", on_delete=models.CASCADE, related_name="knowledge_pages"
    )

    class Meta:
        ordering = ["slug"]
        constraints = [
            models.UniqueConstraint(fields=["slug", "project"], name="uniq_knowledge_page_project"),
        ]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.slug} → {self.project}"
