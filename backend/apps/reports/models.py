"""Bot-written HTML reports (``/reports``).

A routine writes the whole page and publishes it over MCP; people only read.
There is deliberately no series or kind: the title carries that
("Mowafeq insights – W42") and is what you search.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models

KEY_PREFIX = "RPT"


class Report(models.Model):
    title = models.CharField(max_length=300)
    summary = models.CharField(max_length=500, blank=True, default="")
    # No project = staff-only, same rule as meetings and the wiki.
    project = models.ForeignKey(
        "tasks.Project", on_delete=models.SET_NULL, null=True, blank=True, related_name="reports"
    )
    html = models.TextField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self) -> str:
        return f"{self.key} {self.title}"

    @property
    def key(self) -> str:
        # Derived from the id rather than stored: SQLite AUTOINCREMENT (and a
        # Postgres sequence) never reuses an id, so the key is stable for free.
        return f"{KEY_PREFIX}-{self.pk:03d}"


def pk_from_key(ref: str | int) -> int | None:
    """``"RPT-042"``, ``"rpt-42"`` or ``42`` → ``42``; anything else → ``None``."""
    raw = str(ref).strip().upper().removeprefix(f"{KEY_PREFIX}-")
    return int(raw) if raw.isdigit() else None
