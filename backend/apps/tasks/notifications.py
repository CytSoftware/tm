"""Fire-and-forget notification emission for task events.

Mirrors the shape of :mod:`apps.tasks.broadcast`: a single entry point,
:func:`notify_task_event`, that every write path (DRF viewset, MCP tools,
recurring generator) calls after a mutation. It:

1. Resolves the recipient set (default: the task's assignees, minus the
   acting user — never notify someone about their own action).
2. Bulk-creates ``Notification`` rows.
3. Pushes each notification to the recipient's personal Channels group
   (``user_<id>``) so an open browser tab updates live.
4. For ``verb == "assigned"``, fires an email via useSend (best-effort).
5. Dispatches any matching outbound webhook endpoints for the interested
   users (:func:`apps.webhooks.dispatch.dispatch_task_webhooks`). This runs
   even when the recipient set ends up empty — an ``include_self`` endpoint
   whose owner is the sole actor must still fire, and a ``scope="all"``
   org-wide endpoint must see unassigned-task activity too — which is why
   the dispatch call sits *before* the empty-recipients early return.

Some verbs are **webhook-only** (currently just ``"created"``, emitted on
task creation with ``recipients=[]``) — they exist in
``apps.webhooks.models.WEBHOOK_EVENT_TYPES`` but not in ``NotificationVerb``,
and must never produce a ``Notification`` row, WS push, or email. A guard
right after the dispatch call enforces this explicitly (in practice the
empty-recipients return already covers ``created``, since it's always fired
with no recipients — the guard makes the contract robust against a future
webhook-only verb that *does* carry recipients).

Like ``broadcast_task_event``, this must never raise into the caller — every
public entry point is wrapped in try/except.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from django.utils import timezone

from .broadcast import broadcast_to_group
from .models import Notification, NotificationVerb, Task

logger = logging.getLogger(__name__)

# Only these verbs trigger the assignment email — the rest are WS/DB only.
_EMAIL_VERBS = {"assigned"}


def user_group_name(user_id: int) -> str:
    return f"user_{user_id}"


def notify_task_event(
    task: Task,
    actor,
    verb: str,
    recipients: Iterable[Any] | None = None,
    payload: dict | None = None,
) -> None:
    """Notify recipients about a task event. Never raises.

    ``task`` must still be a live, in-memory instance (this may be called
    just *before* deleting it — ``Notification.task`` is ``SET_NULL`` so the
    row survives the cascade). ``actor`` is the user who caused the event, or
    ``None`` for system-generated events (e.g. the recurring generator).
    ``recipients`` defaults to the task's current assignees. The acting user
    is always excluded from the recipient set.
    """
    try:
        _notify_task_event(task, actor, verb, recipients, payload)
    except Exception:  # pragma: no cover - defensive, mirrors broadcast_task_event
        logger.exception(
            "notify_task_event failed (verb=%s task=%s)",
            verb,
            getattr(task, "key", None),
        )


def _notify_task_event(
    task: Task,
    actor,
    verb: str,
    recipients: Iterable[Any] | None,
    payload: dict | None,
) -> None:
    if recipients is None:
        recipient_users = list(task.assignees.all())
    else:
        recipient_users = list(recipients)

    actor_id = getattr(actor, "id", None)
    seen: set[int] = set()
    unique_recipients = []
    for u in recipient_users:
        if u is None or u.id == actor_id or u.id in seen:
            continue
        seen.add(u.id)
        unique_recipients.append(u)

    # Outbound webhooks piggyback on the resolved recipient set. This must
    # run BEFORE the empty-recipients early return below: when the actor is
    # the only interested user, unique_recipients is empty (self-actions are
    # excluded from notifications) but their include_self endpoints still
    # need to fire — e.g. "I assigned myself a task" reaching a PA agent.
    try:
        from apps.webhooks.dispatch import dispatch_task_webhooks

        dispatch_task_webhooks(
            task=task,
            actor=actor,
            verb=verb,
            recipients=unique_recipients,
            extra=payload or {},
        )
    except Exception:  # pragma: no cover - defensive, mirrors broadcast_task_event
        logger.exception(
            "webhook dispatch failed (verb=%s task=%s)",
            verb,
            getattr(task, "key", None),
        )

    # Webhook-only verbs (e.g. "created") never produce a Notification row,
    # WS push, or email — that's the whole point of a webhook-only verb. In
    # practice these are always fired with recipients=[], so the
    # empty-recipients return below already covers it; this guard makes the
    # contract explicit and robust against a future webhook-only verb that
    # does carry recipients.
    if verb not in NotificationVerb.values:
        return

    if not unique_recipients:
        return

    payload = payload or {}
    to_create = [
        Notification(
            recipient=u,
            actor=actor,
            task=task,
            project=task.project,
            verb=verb,
            task_key=task.key,
            task_title=task.title,
            payload=payload,
        )
        for u in unique_recipients
    ]
    created = Notification.objects.bulk_create(to_create)

    project_dict = (
        {"id": task.project_id, "name": task.project.name} if task.project_id else None
    )
    actor_dict = (
        {"id": actor.id, "username": actor.username} if actor is not None else None
    )

    for n, recipient in zip(created, unique_recipients):
        ws_payload = {
            "type": "notification",
            "id": n.id,
            "verb": n.verb,
            "task_key": n.task_key,
            "task_title": n.task_title,
            "project": project_dict,
            "actor": actor_dict,
            "payload": n.payload,
            "read_at": None,
            "created_at": (n.created_at or timezone.now()).isoformat(),
        }
        broadcast_to_group(user_group_name(n.recipient_id), "notify.event", ws_payload)

        if verb in _EMAIL_VERBS and recipient.email:
            from .emails import send_assignment_email

            send_assignment_email(
                to_email=recipient.email,
                task_key=n.task_key,
                task_title=n.task_title,
                project_name=task.project.name if task.project_id else None,
            )
