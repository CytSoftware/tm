"""Task comments — the one write path shared by REST and MCP.

Each write broadcasts ``task.commented`` into the project group, so open
boards refresh the card's comment count and open panels refetch the thread.

Notifications on a new comment:

* ``mentioned`` to every valid ``@username`` in the body;
* ``commented`` to the task's assignees who were not already mentioned.

An edit notifies only mentions it adds, so fixing a typo doesn't re-ping
everyone. Deletes notify nobody. Only the author may edit or delete.
"""

from __future__ import annotations

import re

from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils import timezone

from .broadcast import broadcast_task_event
from .models import Task, TaskComment
from .notifications import notify_task_event

User = get_user_model()

MAX_BODY_CHARS = 10_000
# Not preceded by a word char, so "ali@cyt.com" is not a mention of "cyt.com".
MENTION_RE = re.compile(r"(?<![\w@])@([\w.+-]+)")


def clean_body(body) -> str:
    body = (body or "").strip()
    if not body:
        raise ValueError("A comment needs a body.")
    if len(body) > MAX_BODY_CHARS:
        raise ValueError(f"A comment is at most {MAX_BODY_CHARS} characters.")
    return body


def mentioned_users(body: str) -> list:
    """Active users named as ``@username`` in ``body`` (case-insensitive).

    Tasks are staff-only (see ``access.py``), so only staff can be mentioned —
    anyone else could not open the task the notification points at.
    """
    # Trailing punctuation belongs to the sentence: "thanks @ali."
    names = {m.rstrip(".-+").lower() for m in MENTION_RE.findall(body)} - {""}
    if not names:
        return []
    return list(
        User.objects.annotate(lname=Lower("username"))
        .filter(lname__in=names, is_active=True)
        .filter(Q(is_staff=True) | Q(is_superuser=True))
    )


def _excerpt(body: str) -> str:
    flat = " ".join(body.split())
    return flat if len(flat) <= 140 else flat[:139] + "…"


def _broadcast(task: Task, comment_id: int) -> None:
    broadcast_task_event(
        task.project_id,
        "task.commented",
        {"key": task.key, "id": task.id, "comment_id": comment_id},
    )


def _notify_mentions(task: Task, author, users, comment: TaskComment) -> None:
    if users:
        notify_task_event(
            task,
            author,
            "mentioned",
            recipients=users,
            payload={"comment_id": comment.id, "excerpt": _excerpt(comment.body)},
        )


def _require_author(comment: TaskComment, user) -> None:
    if comment.author_id != getattr(user, "id", None):
        raise PermissionDenied("Only the author can change a comment.")


def add_comment(task: Task, author, body) -> TaskComment:
    comment = TaskComment.objects.create(task=task, author=author, body=clean_body(body))
    mentioned = mentioned_users(comment.body)
    _notify_mentions(task, author, mentioned, comment)
    mentioned_ids = {u.id for u in mentioned}
    notify_task_event(
        task,
        author,
        "commented",
        recipients=[u for u in task.assignees.all() if u.id not in mentioned_ids],
        payload={"comment_id": comment.id, "excerpt": _excerpt(comment.body)},
    )
    _broadcast(task, comment.id)
    return comment


def edit_comment(comment: TaskComment, user, body) -> TaskComment:
    _require_author(comment, user)
    body = clean_body(body)
    if body == comment.body:
        return comment
    before = {u.id for u in mentioned_users(comment.body)}
    comment.body = body
    comment.edited_at = timezone.now()
    comment.save(update_fields=["body", "edited_at", "updated_at"])
    added = [u for u in mentioned_users(body) if u.id not in before]
    _notify_mentions(comment.task, user, added, comment)
    _broadcast(comment.task, comment.id)
    return comment


def delete_comment(comment: TaskComment, user) -> None:
    _require_author(comment, user)
    task, comment_id = comment.task, comment.id
    comment.delete()
    _broadcast(task, comment_id)


def comment_dict(c: TaskComment) -> dict:
    """Plain shape for MCP; REST uses ``TaskCommentSerializer``."""
    return {
        "id": c.id,
        "task": c.task.key,
        "author": c.author.username,
        "body": c.body,
        "created_at": c.created_at.isoformat(),
        "edited_at": c.edited_at.isoformat() if c.edited_at else None,
    }
