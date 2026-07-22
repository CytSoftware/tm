"""Normalization and persistence for the small inbound event inbox."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone as datetime_timezone
from typing import Any, Mapping

from dateutil.parser import isoparse
from django.db import transaction
from django.utils import timezone

from .models import EventProvider, EventSource, ExternalEvent


@dataclass(frozen=True)
class NormalizedEvent:
    external_id: str
    event_type: str
    title: str
    severity: str
    provider_status: str
    target_url: str
    occurred_at: datetime | None


def _at(payload: Mapping[str, Any], path: str) -> Any:
    value: Any = payload
    for part in path.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def _first(payload: Mapping[str, Any], *paths: str) -> Any:
    for path in paths:
        value = _at(payload, path)
        if value is not None and value != "":
            return value
    return None


def _text(value: Any, *, limit: int, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"), sort_keys=True)
    return str(value).strip()[:limit] or default


def _datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=datetime_timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        parsed = isoparse(str(value))
    except (TypeError, ValueError, OverflowError):
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, datetime_timezone.utc)
    return parsed


def _external_id(value: Any) -> str:
    raw = _text(value, limit=2000)
    if not raw:
        return str(uuid.uuid4())
    if len(raw) <= 255:
        return raw
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generic(payload: Mapping[str, Any], headers: Mapping[str, str]) -> NormalizedEvent:
    event_type = _text(
        _first(payload, "event_type", "event", "type", "action"),
        limit=100,
        default="event",
    )
    return NormalizedEvent(
        external_id=_external_id(
            _first(payload, "external_id", "event_id", "id", "uuid")
        ),
        event_type=event_type,
        title=_text(
            _first(payload, "title", "message", "msg", "name"),
            limit=500,
            default=event_type.replace("_", " ").title(),
        ),
        severity=_text(
            _first(payload, "severity", "level", "priority"), limit=50
        ),
        provider_status=_text(
            _first(payload, "status", "state"), limit=100
        ),
        target_url=_text(
            _first(payload, "url", "permalink", "web_url", "html_url"),
            limit=1000,
        ),
        occurred_at=_datetime(
            _first(payload, "occurred_at", "timestamp", "created_at", "date")
        ),
    )


def _sentry(payload: Mapping[str, Any], headers: Mapping[str, str]) -> NormalizedEvent:
    issue = _first(payload, "data.issue", "issue")
    issue = issue if isinstance(issue, Mapping) else {}
    event_type = _text(
        headers.get("Sentry-Hook-Resource")
        or _first(payload, "resource", "action", "type"),
        limit=100,
        default="issue",
    )
    issue_id = _first(
        payload,
        "data.issue.id",
        "issue.id",
        "data.issue.shortId",
        "issue.shortId",
        "data.event.event_id",
        "event.event_id",
        "id",
    )
    return NormalizedEvent(
        external_id=_external_id(issue_id),
        event_type=event_type,
        title=_text(
            issue.get("title")
            or issue.get("shortId")
            or _first(payload, "data.event.title", "event.title", "message"),
            limit=500,
            default="Sentry issue",
        ),
        severity=_text(
            issue.get("level")
            or _first(payload, "data.event.level", "event.level", "level"),
            limit=50,
        ),
        provider_status=_text(
            issue.get("status") or _first(payload, "status", "action"),
            limit=100,
        ),
        target_url=_text(
            issue.get("permalink")
            or issue.get("web_url")
            or _first(payload, "url"),
            limit=1000,
        ),
        occurred_at=_datetime(
            issue.get("lastSeen")
            or issue.get("firstSeen")
            or _first(payload, "data.event.dateCreated", "event.dateCreated")
        ),
    )


def _uptime_kuma(
    payload: Mapping[str, Any], headers: Mapping[str, str]
) -> NormalizedEvent:
    monitor = payload.get("monitor")
    heartbeat = payload.get("heartbeat")
    monitor = monitor if isinstance(monitor, Mapping) else {}
    heartbeat = heartbeat if isinstance(heartbeat, Mapping) else {}
    heartbeat_status = heartbeat.get("status")
    provider_status = _first(payload, "status", "state")
    if heartbeat_status is not None:
        provider_status = "up" if str(heartbeat_status) == "1" else "down"
    severity = _first(payload, "severity", "level")
    if not severity and heartbeat_status is not None:
        severity = "info" if str(heartbeat_status) == "1" else "critical"
    name = monitor.get("name") or _first(payload, "name", "monitor_name")
    return NormalizedEvent(
        external_id=_external_id(
            monitor.get("id") or name or _first(payload, "id", "event_id")
        ),
        event_type="monitor",
        title=_text(
            name or _first(payload, "title", "msg", "message"),
            limit=500,
            default="Uptime monitor",
        ),
        severity=_text(severity, limit=50),
        provider_status=_text(provider_status, limit=100),
        target_url=_text(
            monitor.get("url") or _first(payload, "url"), limit=1000
        ),
        occurred_at=_datetime(
            heartbeat.get("time")
            or _first(payload, "timestamp", "occurred_at", "created_at")
        ),
    )


def normalize_event(
    provider: str,
    payload: Mapping[str, Any],
    headers: Mapping[str, str] | None = None,
) -> NormalizedEvent:
    headers = headers or {}
    if provider == EventProvider.SENTRY:
        return _sentry(payload, headers)
    if provider == EventProvider.UPTIME_KUMA:
        return _uptime_kuma(payload, headers)
    return _generic(payload, headers)


@transaction.atomic
def record_event(
    source: EventSource,
    payload: dict[str, Any],
    headers: Mapping[str, str] | None = None,
) -> tuple[ExternalEvent, bool]:
    normalized = normalize_event(source.provider, payload, headers)
    existing = (
        ExternalEvent.objects.select_for_update()
        .filter(source=source, external_id=normalized.external_id)
        .first()
    )
    fields = {
        "event_type": normalized.event_type,
        "title": normalized.title,
        "severity": normalized.severity,
        "provider_status": normalized.provider_status,
        "target_url": normalized.target_url,
        "occurred_at": normalized.occurred_at,
        "payload": payload,
    }
    if existing is None:
        return (
            ExternalEvent.objects.create(
                source=source,
                external_id=normalized.external_id,
                **fields,
            ),
            True,
        )
    for name, value in fields.items():
        setattr(existing, name, value)
    existing.occurrence_count += 1
    existing.save(update_fields=(*fields.keys(), "occurrence_count", "last_received_at"))
    return existing, False
