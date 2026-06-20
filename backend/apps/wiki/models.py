"""Wiki — a hierarchical, workspace-global knowledge base.

A ``Doc`` is a page in a Notion-style tree (``parent`` self-FK + float
``position`` ordering among siblings). Pages are workspace-global by default
and may optionally be linked to a ``Project``.

Body content is edited collaboratively in the browser with Plate + Yjs. The
authoritative document state is a CRDT (Yjs) binary blob kept in
:class:`DocState` (off the main row so list/tree reads never load it). The
``content`` JSON + ``plain_text`` on ``Doc`` are *denormalized snapshots* of
that CRDT, pushed by the client and used only for read-only render, MCP and
search — the CRDT is the source of truth, the snapshot is best-effort.

Models:

    Doc          — a wiki page (tree node + metadata + snapshot).
    DocState     — 1:1 authoritative Yjs CRDT binary for a Doc.
    DocCounter   — singleton holding the global ``DOC-<N>`` counter.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models, transaction

from .id_generation import generate_doc_key


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Doc(TimestampedModel):
    # ``key`` is blank at construction; filled by save() on first insert.
    key = models.CharField(max_length=32, unique=True, blank=True, editable=False)
    title = models.CharField(max_length=300, default="Untitled", blank=True)

    content = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "Denormalized Plate/Slate value (array of nodes). Snapshot of the "
            "CRDT for read-only render / MCP / search. NOT the source of truth."
        ),
    )
    plain_text = models.TextField(
        blank=True,
        default="",
        help_text="Flattened leaf text from `content`, for search + MCP.",
    )

    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children",
        help_text="Parent page. NULL = top-level. CASCADE deletes the subtree.",
    )
    position = models.FloatField(
        default=1000.0,
        help_text="Sort order among siblings sharing a parent. Midpoint insertion.",
    )

    project = models.ForeignKey(
        "tasks.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="wiki_docs",
        help_text="Optional project link. NULL = workspace-global.",
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_docs",
    )
    last_edited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="edited_docs",
    )

    class Meta:
        ordering = ["parent_id", "position", "id"]
        indexes = [
            models.Index(fields=["parent", "position"]),
            models.Index(fields=["project"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - admin helper
        return f"{self.key} {self.title}"

    def save(self, *args, **kwargs):
        if self._state.adding and not self.key:
            with transaction.atomic():
                self.key = generate_doc_key()
                self._assign_tail_position()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)

    def _assign_tail_position(self):
        tail = (
            Doc.objects.filter(parent_id=self.parent_id)
            .aggregate(m=models.Max("position"))["m"]
        )
        if tail is not None:
            self.position = tail + 1000.0


class DocState(models.Model):
    """Authoritative Yjs CRDT binary state for a Doc.

    Kept in its own table (1:1 with Doc) so the potentially large blob never
    bloats list/tree queries. Written by the collab consumer (debounced + on
    last-client disconnect); hydrated into a fresh Y.Doc when a room opens.
    """

    doc = models.OneToOneField(
        Doc,
        on_delete=models.CASCADE,
        related_name="state",
        primary_key=True,
    )
    state = models.BinaryField(default=bytes, blank=True, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:  # pragma: no cover
        return f"state({self.doc_id})"


class DocCounter(models.Model):
    """Singleton holding the global ``DOC-<N>`` counter.

    A dedicated row keeps the locking surface tiny — every create takes a row
    lock on this single ``id=1`` row and nothing else.
    """

    SINGLETON_PK = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_PK)
    value = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.id = self.SINGLETON_PK
        return super().save(*args, **kwargs)
