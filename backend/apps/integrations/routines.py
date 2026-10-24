"""Routines: live Hermes cron jobs over its api_server, plus the MCP mirror."""

import logging
import re
import threading
import time
from datetime import datetime, timezone

import httpx
from django.conf import settings
from django.db import close_old_connections, transaction
from django.utils.dateparse import parse_datetime
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework.response import Response

from apps.tasks.broadcast import broadcast_task_event
from .models import Routine, RoutineRun

logger = logging.getLogger(__name__)

JOB_FIELDS = ("id", "name", "prompt", "skills", "script", "schedule_display", "enabled", "state", "next_run_at", "last_run_at", "last_status", "last_error", "deliver")


class HermesUnavailable(APIException):
    status_code = 502
    default_detail = "Hermes is unreachable."


class HermesRejected(APIException):
    status_code = 400
    default_detail = "Hermes rejected the request."


def hermes(method, path, **kwargs):
    if not settings.HERMES_API_URL:
        raise HermesUnavailable("Hermes API is not configured (HERMES_API_URL).")
    try:
        response = httpx.request(
            method, settings.HERMES_API_URL + path, timeout=15,
            headers={"Authorization": f"Bearer {settings.HERMES_API_KEY}"}, **kwargs,
        )
    except httpx.HTTPError as exc:
        raise HermesUnavailable(f"Hermes is unreachable ({exc.__class__.__name__}).") from None
    if response.status_code == 404:
        raise NotFound("Not found in Hermes.")
    if response.status_code == 400:
        raise HermesRejected(str(response.json().get("error", HermesRejected.default_detail)))
    if response.is_error:
        raise HermesUnavailable(f"Hermes returned HTTP {response.status_code}.")
    return response.json()


def public_job(job):
    return {key: job.get(key) for key in JOB_FIELDS}


def record_finished_runs(jobs):
    for job in jobs:
        run_at = parse_datetime(job.get("last_run_at") or "")
        if not run_at:
            continue
        run, created = RoutineRun.objects.get_or_create(
            job_id=job["id"], run_at=run_at,
            defaults={"status": job.get("last_status") or "", "error": job.get("last_error") or ""},
        )
        if created and run.status == "ok":
            mark_reported_failure(run)


def mark_reported_failure(run):
    """A routine reports a failed step by starting its final reply with FAILED.

    Hermes records those runs as ok because the agent itself finished, so the
    outcome is read from the reply once, when the run is first recorded.
    """
    try:
        sessions = [s for s in cron_sessions(run.job_id) if s["started_at"] <= run.run_at.timestamp()]
        reply = final_reply(max(sessions, key=lambda s: s["started_at"])["id"]) if sessions else ""
    except APIException:
        return  # ponytail: a Hermes hiccup here leaves this one run marked ok.
    if reply.lstrip().startswith("FAILED"):
        run.status, run.error = "error", reply.strip().splitlines()[0][:4000]
        run.save(update_fields=["status", "error"])


def final_reply(session_id):
    return last_reply(hermes("GET", f"/api/sessions/{session_id}/messages")["data"])


def last_reply(messages):
    replies = [m["content"] for m in messages if m["role"] == "assistant" and isinstance(m.get("content"), str) and m["content"].strip()]
    return replies[-1] if replies else ""


def with_saved_status(job):
    """Prefer TM's recorded outcome for the latest run (it can be a reported failure)."""
    run = RoutineRun.objects.filter(job_id=job.get("id"), run_at=parse_datetime(job.get("last_run_at") or "")).first() if job.get("last_run_at") else None
    if run and run.status:
        job = {**job, "last_status": run.status, "last_error": run.error or job.get("last_error")}
    return public_job(job)


def match_runs(sessions, saved, gated=False):
    """Pair cron sessions with saved outcomes.

    A run's ``last_run_at`` is stamped just after its session ends, so each
    session owns the first saved outcome before the next session starts.
    Outcomes with no session are listed on their own: on a job with a gate
    script, a successful run without a session is the gate skipping the agent.
    """
    sessions = sorted(sessions, key=lambda s: s["started_at"])
    saved = sorted(saved, key=lambda r: r.run_at)
    runs = []
    for i, session in enumerate(sessions):
        start = datetime.fromtimestamp(session["started_at"], timezone.utc)
        end = datetime.fromtimestamp(sessions[i + 1]["started_at"], timezone.utc) if i + 1 < len(sessions) else None
        match = next((r for r in saved if r.run_at >= start and (end is None or r.run_at < end)), None)
        if match:
            saved.remove(match)
        status = match.status if match else ("running" if session["ended_at"] is None and end is None else "")
        runs.append({
            "session_id": session["id"], "started_at": start.isoformat(),
            "finished_at": match.run_at.isoformat() if match else None,
            "status": status, "error": match.error if match else "",
        })
    runs += [{
        "session_id": None, "started_at": None, "finished_at": r.run_at.isoformat(),
        "status": "skipped" if gated and r.status == "ok" else r.status, "error": r.error,
    } for r in saved]
    return sorted(runs, key=lambda r: r["started_at"] or r["finished_at"], reverse=True)


def cron_sessions(job_id):
    # ponytail: scans every cron session per request; page the API by job if this passes a few thousand.
    prefix, sessions, offset = f"cron_{job_id}_", [], 0
    while True:
        page = hermes("GET", "/api/sessions", params={"source": "cron", "limit": 200, "offset": offset})
        sessions += [s for s in page["data"] if s["id"].startswith(prefix)]
        if not page["has_more"]:
            return sessions
        offset += 200


def start_run_recorder(interval=60):
    """Save run outcomes even when nobody has the routines page open."""
    if not settings.HERMES_API_URL:
        return

    def loop():
        while True:
            close_old_connections()
            try:
                record_finished_runs(hermes("GET", "/api/jobs", params={"include_disabled": "true"})["jobs"])
            except Exception:
                logger.warning("Routine run recorder failed", exc_info=True)
            time.sleep(interval)

    threading.Thread(target=loop, name="routine-run-recorder", daemon=True).start()


class RoutineSerializer(serializers.ModelSerializer):
    external_id = serializers.RegexField(r"^(cron|webhook|manual):[A-Za-z0-9_-]+$", max_length=200)
    instructions = serializers.CharField(max_length=50000, allow_blank=True, required=False)
    skills = serializers.ListField(child=serializers.CharField(max_length=200), max_length=50, required=False)

    class Meta:
        model = Routine
        fields = ("id", "external_id", "name", "instructions", "trigger_type", "trigger_description", "enabled", "skills", "next_run_at", "last_run_at", "last_run_status", "synced_at")
        read_only_fields = ("id", "synced_at")

    def validate(self, attrs):
        unknown = set(self.initial_data) - (set(self.fields) - set(self.Meta.read_only_fields))
        if unknown:
            raise ValidationError(f"Unknown or read-only fields: {', '.join(sorted(unknown))}")
        external_id = attrs.get("external_id", getattr(self.instance, "external_id", ""))
        kind = attrs.get("trigger_type", getattr(self.instance, "trigger_type", ""))
        if kind and external_id.split(":")[0] != {"schedule": "cron", "webhook": "webhook", "manual": "manual"}[kind]:
            raise ValidationError({"external_id": "Prefix must match the trigger type: cron:, webhook:, or manual:."})
        if not attrs.get("enabled", getattr(self.instance, "enabled", True)):
            attrs["next_run_at"] = None
        return attrs


class RoutineViewSet(viewsets.ViewSet):
    lookup_value_regex = r"[A-Za-z0-9_-]+"

    def list(self, request):
        jobs = hermes("GET", "/api/jobs", params={"include_disabled": "true"})["jobs"]
        record_finished_runs(jobs)
        return Response({"results": [with_saved_status(job) for job in jobs]})

    def retrieve(self, request, pk):
        job = hermes("GET", f"/api/jobs/{pk}")["job"]
        record_finished_runs([job])
        return Response(with_saved_status(job))

    def partial_update(self, request, pk):
        prompt = request.data.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise HermesRejected("Instructions cannot be empty.")
        return Response(public_job(hermes("PATCH", f"/api/jobs/{pk}", json={"prompt": prompt})["job"]))

    @action(detail=True, methods=["post"])
    def run(self, request, pk):
        return Response(public_job(hermes("POST", f"/api/jobs/{pk}/run")["job"]))

    @action(detail=True, methods=["get"])
    def runs(self, request, pk):
        gated = bool(hermes("GET", f"/api/jobs/{pk}")["job"].get("script"))
        return Response({"results": match_runs(cron_sessions(pk), RoutineRun.objects.filter(job_id=pk), gated)})

    @action(detail=True, methods=["get"], url_path=r"runs/(?P<session_id>[A-Za-z0-9_]+)")
    def recap(self, request, pk, session_id):
        # Only this job's cron sessions: the same API also serves private chats.
        if not re.fullmatch(rf"cron_{re.escape(pk)}_\d{{8}}_\d{{6}}", session_id):
            raise NotFound("Not a run of this routine.")
        messages = hermes("GET", f"/api/sessions/{session_id}/messages")["data"]
        return Response({"recap": last_reply(messages), "messages": [transcript_entry(m) for m in messages]})


# ponytail: tool outputs reach ~90 KB and runs ~1000 messages; clip instead of paging.
MAX_MESSAGE_CHARS = 4000


def transcript_entry(message):
    content = message.get("content")
    content = content if isinstance(content, str) else ("" if content is None else str(content))
    calls = [(call.get("function") or call).get("name", "") for call in message.get("tool_calls") or [] if isinstance(call, dict)]
    return {
        "role": message.get("role"), "tool_name": message.get("tool_name"), "tool_calls": [c for c in calls if c],
        "content": content[:MAX_MESSAGE_CHARS], "truncated": len(content) > MAX_MESSAGE_CHARS,
    }


def list_routines(limit=100, offset=0):
    if not 1 <= limit <= 200 or offset < 0:
        raise ValueError("Use limit 1–200 and offset >= 0.")
    qs = Routine.objects.all()
    return {"count": qs.count(), "results": RoutineSerializer(qs[offset:offset + limit], many=True).data}


def get_routine(external_id):
    try:
        return Routine.objects.get(external_id=external_id)
    except Routine.DoesNotExist:
        raise NotFound("Routine mirror not found. List routines to find its external_id.") from None


def save_routine(external_id, fields, *, create=False, mcp_user=None):
    with transaction.atomic():
        existing = Routine.objects.select_for_update().filter(external_id=external_id).first()
        if existing is None and not create:
            raise NotFound("Routine mirror not found.")
        if "external_id" in fields:
            raise ValidationError("external_id cannot be changed.")
        serializer = RoutineSerializer(existing, data={**fields, "external_id": external_id}, partial=not create)
        serializer.is_valid(raise_exception=True)
        routine, _ = Routine.objects.update_or_create(
            external_id=external_id, defaults={**serializer.validated_data, "updated_by": mcp_user},
        )
        # Project 0 is the authenticated workspace-wide routine channel.
        transaction.on_commit(lambda: broadcast_task_event(0, "routine.updated", {"id": routine.id}))
    return RoutineSerializer(routine).data


def delete_routine(external_id, *, mcp_user=None):
    with transaction.atomic():
        count, _ = Routine.objects.filter(external_id=external_id).delete()
        transaction.on_commit(lambda: broadcast_task_event(0, "routine.deleted", {"external_id": external_id, "actor_id": getattr(mcp_user, "id", None)}))
    return {"external_id": external_id, "deleted": bool(count), "hermes_changed": False}
