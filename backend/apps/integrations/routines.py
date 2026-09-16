"""Read-only routine API and validated MCP writes to the Hermes mirror."""

from django.db import transaction
from rest_framework import serializers, viewsets
from rest_framework.exceptions import NotFound, ValidationError

from apps.tasks.broadcast import broadcast_task_event
from .models import Routine


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


class RoutineViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Routine.objects.all()
    serializer_class = RoutineSerializer


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
