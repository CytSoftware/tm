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
    StateTransition,
    Task,
    View,
)
from .transitions import compute_staleness

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
        if not profile:
            return ""
        raw = profile.effective_avatar_url
        if not raw:
            return ""
        # Uploaded files come back as a relative /media/... path — turn it
        # into an absolute URL so the Next frontend can hot-link it from a
        # different origin. External URLs pass through unchanged.
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        request = self.context.get("request")
        if request is not None:
            return request.build_absolute_uri(raw)
        return raw


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
    assignees = UserSerializer(many=True, read_only=True)
    reporter = UserSerializer(read_only=True)
    labels = LabelSerializer(many=True, read_only=True)
    column = ColumnSerializer(read_only=True)
    project = serializers.PrimaryKeyRelatedField(read_only=True)
    project_prefix = serializers.CharField(
        source="project.prefix", read_only=True, default=None
    )
    project_name = serializers.CharField(
        source="project.name", read_only=True, default=None
    )
    project_color = serializers.CharField(
        source="project.color", read_only=True, default=None
    )
    is_recurring_instance = serializers.SerializerMethodField()
    # ``current_column_since`` comes from a queryset annotation added by
    # ``base_task_queryset``. May be null for tasks without a column or
    # legacy tasks whose transitions have been purged.
    current_column_since = serializers.DateTimeField(read_only=True, allow_null=True)
    staleness = serializers.SerializerMethodField()

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
            "project_color",
            "column",
            "position",
            "assignees",
            "reporter",
            "labels",
            "priority",
            "story_points",
            "recurrence_template",
            "is_recurring_instance",
            "due_at",
            "created_at",
            "updated_at",
            "current_column_since",
            "staleness",
        )
        read_only_fields = fields  # the write serializer is separate

    def get_is_recurring_instance(self, obj: Task) -> bool:
        return obj.recurrence_template_id is not None

    def get_staleness(self, obj: Task) -> str | None:
        thresholds = self.context.get("staleness_thresholds")
        return compute_staleness(obj, thresholds=thresholds)


class StateTransitionSerializer(serializers.ModelSerializer):
    from_column = ColumnSerializer(read_only=True)
    to_column = ColumnSerializer(read_only=True)
    triggered_by = UserSerializer(read_only=True)

    class Meta:
        model = StateTransition
        fields = (
            "id",
            "from_column",
            "to_column",
            "at",
            "triggered_by",
            "source",
        )
        read_only_fields = fields


class StalenessSettingsSerializer(serializers.Serializer):
    """Shape of the staleness settings endpoint response/payload.

    ``thresholds`` maps a column name (matched case-sensitively) to a dict
    with integer ``yellow_days`` and ``red_days``. A column can omit either
    key to disable that tier. Done columns are always excluded from
    staleness regardless of the map.
    """

    thresholds = serializers.JSONField()


class TaskWriteSerializer(serializers.ModelSerializer):
    """Accepts project_id, column_id, assignee_ids, label_ids for writes.

    ``project_id`` and ``column_id`` are both optional: a task with neither
    lives in the Inbox (no project, no column).
    """

    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(),
        source="project",
        write_only=True,
        required=False,
        allow_null=True,
    )
    column_id = serializers.PrimaryKeyRelatedField(
        queryset=Column.objects.all(),
        source="column",
        write_only=True,
        required=False,
        allow_null=True,
    )
    assignee_ids = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source="assignees",
        many=True,
        write_only=True,
        required=False,
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
            "assignee_ids",
            "label_ids",
            "priority",
            "story_points",
            "due_at",
        )
        read_only_fields = ("id", "key")

    def validate(self, attrs):
        # Resolve the effective project / column for validation. A missing
        # key in attrs means "don't touch" on update, "no value" on create.
        has_project_key = "project" in attrs
        has_column_key = "column" in attrs

        project = (
            attrs.get("project")
            if has_project_key
            else (self.instance.project if self.instance else None)
        )
        column = (
            attrs.get("column")
            if has_column_key
            else (self.instance.column if self.instance else None)
        )

        # When the project changes on update, auto-map the column to a
        # same-named column in the new project (or the first non-done column).
        if (
            self.instance
            and has_project_key
            and (attrs["project"].id if attrs["project"] else None)
            != self.instance.project_id
        ):
            new_project = attrs["project"]
            if new_project is None:
                # Moving into the Inbox clears the column entirely.
                attrs["column"] = None
                column = None
            else:
                sent_column = attrs.get("column") if has_column_key else None
                needs_remap = (
                    sent_column is None
                    or sent_column.project_id != new_project.id
                )
                if needs_remap:
                    old_col_name = (
                        sent_column.name
                        if sent_column
                        else (self.instance.column.name if self.instance.column else None)
                    )
                    mapped = None
                    if old_col_name:
                        mapped = new_project.columns.filter(name=old_col_name).first()
                    mapped = (
                        mapped
                        or new_project.columns.filter(is_done=False).order_by("order").first()
                        or new_project.columns.order_by("order").first()
                    )
                    if mapped is None:
                        raise serializers.ValidationError(
                            {"project_id": "Target project has no columns."}
                        )
                    attrs["column"] = mapped
                    column = mapped

        if project is None and column is not None:
            raise serializers.ValidationError(
                {"column_id": "Cannot set a column on a projectless task."}
            )
        if project is not None and column is not None and column.project_id != project.id:
            raise serializers.ValidationError(
                {"column_id": "Column does not belong to the selected project."}
            )

        labels = attrs.get("labels")
        if labels:
            if project is None:
                # Inbox tasks can only carry global (project-less) labels.
                if any(label.project_id is not None for label in labels):
                    raise serializers.ValidationError(
                        {"label_ids": "Projectless tasks can only use global labels."}
                    )
            else:
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
        assignees = validated_data.pop("assignees", None)
        validated_data.setdefault("reporter", request.user if request else None)
        task = Task.objects.create(**validated_data)
        if labels:
            task.labels.set(labels)
        if assignees is not None:
            task.assignees.set(assignees)
        return task

    def update(self, instance, validated_data):
        from .id_generation import generate_task_key

        labels = validated_data.pop("labels", None)
        assignees = validated_data.pop("assignees", None)

        new_project = validated_data.get("project", instance.project) if "project" in validated_data else instance.project
        old_project_id = instance.project_id
        project_changed = "project" in validated_data and (
            (new_project.id if new_project else None) != old_project_id
        )

        for attr, value in validated_data.items():
            setattr(instance, attr, value)

        if project_changed:
            # Moving to a new project re-keys the task so the prefix matches
            # the destination. Moving to the Inbox uses the row id (which is
            # already assigned since this is an update path).
            if instance.project_id:
                instance.key = generate_task_key(instance.project)
            else:
                instance.key = f"INBOX-{instance.id:03d}"
            instance.save()
            instance.labels.clear()  # labels belonged to the old project
        else:
            instance.save()

        if labels is not None:
            instance.labels.set(labels)
        if assignees is not None:
            instance.assignees.set(assignees)
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
    assignees = UserSerializer(many=True, read_only=True)
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
            "assignees",
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
    assignee_ids = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source="assignees",
        many=True,
        write_only=True,
        required=False,
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
            "assignee_ids",
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
        assignees = validated_data.pop("assignees", None)
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
        if assignees is not None:
            template.assignees.set(assignees)
        return template

    def update(self, instance, validated_data):
        from .recurring import compute_initial_next_run

        labels = validated_data.pop("labels", None)
        assignees = validated_data.pop("assignees", None)
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
        if assignees is not None:
            instance.assignees.set(assignees)
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
