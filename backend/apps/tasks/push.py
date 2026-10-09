"""Web Push to installed PWAs / browsers that opted in.

Same contract as :mod:`apps.tasks.emails`: best-effort, never raises, and the
HTTP calls run in a daemon thread so a slow push service never blocks a write
path. An empty ``VAPID_PRIVATE_KEY`` disables sending.
"""

from __future__ import annotations

import json
import logging
import threading

from django.conf import settings
from django.db import connection

from .models import PushSubscription

logger = logging.getLogger(__name__)

_TTL_SECONDS = 24 * 60 * 60


def send_push(*, user_id: int, title: str, body: str, url: str) -> None:
    private_key = settings.VAPID_PRIVATE_KEY
    if not private_key:
        return
    subs = list(
        PushSubscription.objects.filter(user_id=user_id).values(
            "endpoint", "p256dh", "auth"
        )
    )
    if not subs:
        return
    data = json.dumps({"title": title, "body": body, "url": url})

    def _send() -> None:
        from pywebpush import WebPushException, webpush

        gone = []
        for s in subs:
            try:
                webpush(
                    subscription_info={
                        "endpoint": s["endpoint"],
                        "keys": {"p256dh": s["p256dh"], "auth": s["auth"]},
                    },
                    data=data,
                    vapid_private_key=private_key,
                    vapid_claims={"sub": settings.VAPID_SUBJECT},
                    ttl=_TTL_SECONDS,
                    timeout=5,
                )
            except WebPushException as e:
                status = getattr(e.response, "status_code", None)
                # 404/410: the browser dropped this subscription for good.
                if status in (404, 410):
                    gone.append(s["endpoint"])
                else:
                    logger.warning("web push failed (%s): %s", status, e)
            except Exception:  # pragma: no cover - defensive
                logger.exception("web push raised")
        if gone:
            try:
                PushSubscription.objects.filter(endpoint__in=gone).delete()
            finally:
                connection.close()  # this thread's own connection

    threading.Thread(target=_send, daemon=True).start()
