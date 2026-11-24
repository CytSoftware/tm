"""Task comments — the one write path shared by REST and MCP.

Each write broadcasts ``task.commented`` into the project group, so open
boards refresh the card's comment count and open panels refetch the thread.
A new comment sends ``commented`` to the task's assignees (minus the author);
edits and deletes notify nobody. Only the author may edit or delete.
"""

from __future__ import annotations

from django.core.exceptions import PermissionDenied
from django.utils import timezone

from .broadcast import broadcast_task_event
from .models import Task, TaskComment
from .notifications import notify_task_event

MAX_BODY_CHARS = 10_000


def clean_body(body) -> str:
    body = (body or "").strip()
    if not body:
        raise ValueError("A comment needs a body.")
    if len(body) > MAX_BODY_CHARS:
        raise ValueError(f"A comment is at most {MAX_BODY_CHARS} characters.")
    return body


def _excerpt(body: str) -> str:
    flat = " ".join(body.split())
    return flat if len(flat) <= 140 else flat[:139] + "…"


def _broadcast(task: Task, comment_id: int) -> None:
    broadcast_task_event(
        task.project_id,
        "task.commented",
        {"key": task.key, "id": task.id, "comment_id": comment_id},
    )


def _require_author(comment: TaskComment, user) -> None:
    if comment.author_id != getattr(user, "id", None):
        raise PermissionDenied("Only the author can change a comment.")


def add_comment(task: Task, author, body) -> TaskComment:
    comment = TaskComment.objects.create(task=task, author=author, body=clean_body(body))
    notify_task_event(
        task,
        author,
        "commented",
        payload={"comment_id": comment.id, "excerpt": _excerpt(comment.body)},
    )
    _broadcast(task, comment.id)
    return comment


def edit_comment(comment: TaskComment, user, body) -> TaskComment:
    _require_author(comment, user)
    body = clean_body(body)
    if body == comment.body:
        return comment
    comment.body = body
    comment.edited_at = timezone.now()
    comment.save(update_fields=["body", "edited_at", "updated_at"])
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
