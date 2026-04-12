"""DRF serializers for the task tracker.

Convention: reads are nested (assignee/labels/column/project expanded so the
frontend doesn't need N+1 calls), writes use plain PK fields
(``assignee_id``, ``column_id``, ``label_ids``, etc.) to avoid ambiguity.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from .models import (
    Column,
    Label,
    Project,
    RecurringTaskTemplate,
    Task,
    View,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


class UserSerializer(serializers.ModelSerializer):
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "username", "email", "first_name", "last_name", "avatar_url")

    def get_avatar_url(self, obj) -> str:
        profile = getattr(obj, "profile", None)
        if profile and profile.avatar_url:
            return profile.avatar_url
        return ""


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ("id", "project", "name", "color")


class ColumnSerializer(serializers.ModelSerializer):
    class Meta:
        model = Column
        fields = ("id", "project", "name", "order", "is_done")


class ProjectSerializer(serializers.ModelSerializer):
    columns = ColumnSerializer(many=True, read_only=True)
    is_starred = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = (
            "id",
            "name",
            "prefix",
            "description",
            "color",
            "icon",
            "archived",
            "task_counter",
            "columns",
            "is_starred",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "task_counter",
            "is_starred",
            "created_at",
            "updated_at",
        )

    def get_is_starred(self, obj: Project) -> bool:
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return False
        profile = getattr(user, "profile", None)
        if profile is None:
            return False
        return profile.starred_projects.filter(pk=obj.pk).exists()


# ---------------------------------------------------------------------------
# Task — read vs write split
# ---------------------------------------------------------------------------


class TaskReadSerializer(serializers.ModelSerializer):
    assignee = UserSerializer(read_only=True)
    reporter = UserSerializer(read_only=True)
    labels = LabelSerializer(many=True, read_only=True)
    column = ColumnSerializer(read_only=True)
    project = serializers.PrimaryKeyRelatedField(read_only=True)
    project_prefix = serializers.CharField(source="project.prefix", read_only=True)
    project_name = serializers.CharField(source="project.name", read_only=True)
    is_recurring_instance = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = (
            "id",
            "key",
            "title",
            "description",
            "project",
            "project_prefix",
            "project_name",
            "column",
            "position",
            "assignee",
            "reporter",
            "labels",
            "priority",
            "story_points",
            "recurrence_template",
            "is_recurring_instance",
            "due_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields  # the write serializer is separate

    def get_is_recurring_instance(self, obj: Task) -> bool:
        return obj.recurrence_template_id is not None


class TaskWriteSerializer(serializers.ModelSerializer):
    """Accepts project_id, column_id, assignee_id, label_ids for writes."""

    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), source="project", write_only=True
    )
    column_id = serializers.PrimaryKeyRelatedField(
        queryset=Column.objects.all(), source="column", write_only=True
    )
    assignee_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source="assignee",
        write_only=True,
        required=False,
        allow_null=True,
    )
    label_ids = serializers.PrimaryKeyRelatedField(
        queryset=Label.objects.all(),
        source="labels",
        many=True,
        write_only=True,
        required=False,
    )

    class Meta:
        model = Task
        fields = (
            "id",
            "key",
            "title",
            "description",
            "project_id",
            "column_id",
            "position",
            "assignee_id",
            "label_ids",
            "priority",
            "story_points",
            "due_at",
        )
        read_only_fields = ("id", "key")

    def validate(self, attrs):
        project = attrs.get("project") or (self.instance and self.instance.project)
        column = attrs.get("column") or (self.instance and self.instance.column)

        # When the project changes on update, auto-map the column to a
        # same-named column in the new project (or the first non-done column).
        if (
            self.instance
            and "project" in attrs
            and attrs["project"].id != self.instance.project_id
        ):
            new_project = attrs["project"]
            # Auto-map the column: if no column was sent, OR the sent column
            # belongs to the OLD project, find a matching column in the new one.
            sent_column = attrs.get("column")
            needs_remap = (
                sent_column is None
                or sent_column.project_id != new_project.id
            )
            if needs_remap:
                # Try same-named column in the new project, then first non-done
                old_col_name = (
                    sent_column.name
                    if sent_column
                    else self.instance.column.name
                )
                mapped = (
                    new_project.columns.filter(name=old_col_name).first()
                    or new_project.columns.filter(is_done=False).order_by("order").first()
                    or new_project.columns.order_by("order").first()
                )
                if mapped is None:
                    raise serializers.ValidationError(
                        {"project_id": "Target project has no columns."}
                    )
                attrs["column"] = mapped
                column = mapped

        if project and column and column.project_id != project.id:
            raise serializers.ValidationError(
                {"column_id": "Column does not belong to the selected project."}
            )
        labels = attrs.get("labels")
        if project and labels:
            # Labels must be global (project=None) or belong to the task's project
            if any(
                label.project_id is not None and label.project_id != project.id
                for label in labels
            ):
                raise serializers.ValidationError(
                    {"label_ids": "Labels must be global or belong to the task's project."}
                )
        return attrs

    def create(self, validated_data):
        request = self.context.get("request")
        labels = validated_data.pop("labels", None)
        validated_data.setdefault("reporter", request.user if request else None)
        task = Task.objects.create(**validated_data)
        if labels:
            task.labels.set(labels)
        return task

    def update(self, instance, validated_data):
        from .id_generation import generate_task_key

        labels = validated_data.pop("labels", None)
        project_changed = (
            "project" in validated_data
            and validated_data["project"].id != instance.project_id
        )

        for attr, value in validated_data.items():
            setattr(instance, attr, value)

        # Re-key the task when the project changes so the prefix matches.
        if project_changed:
            instance.key = generate_task_key(instance.project)
            # Clear labels — they belong to the old project.
            instance.save()
            instance.labels.clear()
        else:
            instance.save()

        if labels is not None:
            instance.labels.set(labels)
        return instance


class TaskMoveSerializer(serializers.Serializer):
    """Payload for the ``/tasks/{key}/move/`` action."""

    column_id = serializers.IntegerField()
    position = serializers.FloatField(required=False)
    before_id = serializers.IntegerField(required=False, allow_null=True)
    after_id = serializers.IntegerField(required=False, allow_null=True)


# ---------------------------------------------------------------------------
# View (saved view)
# ---------------------------------------------------------------------------


class ViewSerializer(serializers.ModelSerializer):
    class Meta:
        model = View
        fields = (
            "id",
            "owner",
            "name",
            "project",
            "kind",
            "filters",
            "sort",
            "shared",
            "card_display",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("owner", "created_at", "updated_at")

    def create(self, validated_data):
        validated_data["owner"] = self.context["request"].user
        return super().create(validated_data)


# ---------------------------------------------------------------------------
# Recurring task template
# ---------------------------------------------------------------------------


class RecurringTaskTemplateReadSerializer(serializers.ModelSerializer):
    assignee = UserSerializer(read_only=True)
    labels = LabelSerializer(many=True, read_only=True)
    column = ColumnSerializer(read_only=True)
    project_prefix = serializers.CharField(source="project.prefix", read_only=True)
    created_by = UserSerializer(read_only=True)

    class Meta:
        model = RecurringTaskTemplate
        fields = (
            "id",
            "project",
            "project_prefix",
            "title",
            "description",
            "assignee",
            "labels",
            "column",
            "priority",
            "story_points",
            "rrule",
            "dtstart",
            "timezone",
            "next_run_at",
            "last_generated_at",
            "active",
            "created_by",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class RecurringTaskTemplateWriteSerializer(serializers.ModelSerializer):
    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), source="project", write_only=True
    )
    column_id = serializers.PrimaryKeyRelatedField(
        queryset=Column.objects.all(),
        source="column",
        write_only=True,
        required=False,
    )
    assignee_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source="assignee",
        write_only=True,
        required=False,
        allow_null=True,
    )
    label_ids = serializers.PrimaryKeyRelatedField(
        queryset=Label.objects.all(),
        source="labels",
        many=True,
        write_only=True,
        required=False,
    )

    class Meta:
        model = RecurringTaskTemplate
        fields = (
            "id",
            "project_id",
            "title",
            "description",
            "column_id",
            "assignee_id",
            "label_ids",
            "priority",
            "story_points",
            "rrule",
            "dtstart",
            "timezone",
            "active",
        )
        read_only_fields = ("id",)

    def validate(self, attrs):
        # Lazy import — recurring.py depends on models.py; models.py doesn't
        # depend on recurring.py. Keep it one-way.
        from .recurring import validate_rrule

        rrule = attrs.get("rrule") or (self.instance and self.instance.rrule)
        dtstart = attrs.get("dtstart") or (self.instance and self.instance.dtstart)
        if rrule and dtstart:
            try:
                validate_rrule(rrule, dtstart)
            except ValueError as e:
                raise serializers.ValidationError({"rrule": str(e)}) from e

        project = attrs.get("project") or (self.instance and self.instance.project)
        column = attrs.get("column") or (self.instance and self.instance.column)
        if project and column and column.project_id != project.id:
            raise serializers.ValidationError(
                {"column_id": "Column does not belong to the selected project."}
            )
        return attrs

    def create(self, validated_data):
        from .recurring import compute_initial_next_run

        request = self.context.get("request")
        labels = validated_data.pop("labels", None)
        validated_data.setdefault("created_by", request.user if request else None)
        if "column" not in validated_data:
            project = validated_data["project"]
            validated_data["column"] = (
                project.columns.filter(is_done=False).order_by("order").first()
                or project.columns.order_by("order").first()
            )
        validated_data["next_run_at"] = compute_initial_next_run(
            validated_data["rrule"],
            validated_data["dtstart"],
        )
        template = RecurringTaskTemplate.objects.create(**validated_data)
        if labels:
            template.labels.set(labels)
        return template

    def update(self, instance, validated_data):
        from .recurring import compute_initial_next_run

        labels = validated_data.pop("labels", None)
        rrule_changed = "rrule" in validated_data and validated_data["rrule"] != instance.rrule
        dtstart_changed = (
            "dtstart" in validated_data and validated_data["dtstart"] != instance.dtstart
        )
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if rrule_changed or dtstart_changed:
            instance.next_run_at = compute_initial_next_run(
                instance.rrule, instance.dtstart
            )
        instance.save()
        if labels is not None:
            instance.labels.set(labels)
        return instance


class RecurringPreviewSerializer(serializers.Serializer):
    count = serializers.IntegerField(required=False, default=5, min_value=1, max_value=50)


# ---------------------------------------------------------------------------
# Auth payload serializers (mainly for OpenAPI schema generation)
# ---------------------------------------------------------------------------


class LoginRequestSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(style={"input_type": "password"})


class CsrfResponseSerializer(serializers.Serializer):
    csrfToken = serializers.CharField()
