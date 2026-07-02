"""Assignment notification emails via useSend (https://usesend.com).

Only ``notify_task_event`` (verb == "assigned") calls into this module. It's
best-effort: an empty ``USESEND_API_KEY`` disables sending entirely, and the
actual HTTP POST runs in a short-lived daemon thread so request latency is
unaffected and a slow/unreachable useSend never blocks a write path.

API shape (verified against https://docs.usesend.com/api-reference/emails/send-email):
    POST {USESEND_BASE_URL}/api/v1/emails
    Authorization: Bearer <USESEND_API_KEY>
    Content-Type: application/json
    {"to": "...", "from": "...", "subject": "...", "html": "...", "text": "..."}
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

_SEND_TIMEOUT_SECONDS = 5


def send_assignment_email(
    *,
    to_email: str,
    task_key: str,
    task_title: str,
    project_name: str | None,
) -> None:
    """Fire-and-forget "you were assigned" email. No-op if email is disabled
    (``USESEND_API_KEY`` unset) or ``to_email`` is blank.

    All email content is built synchronously here (no DB/ORM access) so the
    background thread only performs the HTTP POST — Django DB connections
    aren't safe to share across threads.
    """
    api_key = getattr(settings, "USESEND_API_KEY", "")
    if not api_key or not to_email:
        return

    base_url = getattr(settings, "USESEND_BASE_URL", "https://app.usesend.com").rstrip("/")
    from_email = getattr(settings, "USESEND_FROM_EMAIL", "")
    frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000").rstrip("/")
    board_url = f"{frontend_url}/board"

    subject = f"[{task_key}] You were assigned: {task_title}"
    project_suffix = f" in {project_name}" if project_name else ""
    text = (
        f"You were assigned to {task_key} — {task_title}{project_suffix}.\n\n"
        f"View it on the board: {board_url}\n"
    )
    html = (
        f"<p>You were assigned to <strong>{task_key}</strong> — "
        f"{task_title}{project_suffix}.</p>"
        f'<p><a href="{board_url}">View it on the board</a></p>'
    )

    body = json.dumps(
        {
            "to": to_email,
            "from": from_email,
            "subject": subject,
            "html": html,
            "text": text,
        }
    ).encode()
    url = f"{base_url}/api/v1/emails"

    def _send() -> None:
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=_SEND_TIMEOUT_SECONDS).read()
        except urllib.error.URLError as e:
            logger.warning("useSend email POST to %s failed: %s", url, e)
        except Exception:  # pragma: no cover - defensive
            logger.exception("useSend email POST raised")

    threading.Thread(target=_send, daemon=True).start()
