"""DRF serializers for pipelines."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from .models import Pipeline, PipelineEvent, Stage

User = get_user_model()


class _UserSlim(serializers.ModelSerializer):
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
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        request = self.context.get("request")
        if request is not None:
            return request.build_absolute_uri(raw)
        return raw


class StageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Stage
        fields = ("id", "name", "order", "color", "is_terminal")


class PipelineEventSerializer(serializers.ModelSerializer):
    author = _UserSlim(read_only=True)

    class Meta:
        model = PipelineEvent
        fields = ("id", "pipeline", "body", "author", "created_at")
        read_only_fields = ("id", "author", "created_at")


class PipelineEventWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = PipelineEvent
        fields = ("id", "body")
        read_only_fields = ("id",)


class PipelineReadSerializer(serializers.ModelSerializer):
    stage = StageSerializer(read_only=True)
    owner = _UserSlim(read_only=True)
    created_by = _UserSlim(read_only=True)
    event_count = serializers.IntegerField(read_only=True)
    last_event_at = serializers.DateTimeField(read_only=True, allow_null=True)

    class Meta:
        model = Pipeline
        fields = (
            "id",
            "key",
            "title",
            "description",
            "counterparty",
            "stage",
            "position",
            "owner",
            "created_by",
            "event_count",
            "last_event_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class PipelineDetailSerializer(PipelineReadSerializer):
    """Detail view also includes the full timeline."""

    events = PipelineEventSerializer(many=True, read_only=True)

    class Meta(PipelineReadSerializer.Meta):
        fields = PipelineReadSerializer.Meta.fields + ("events",)
        read_only_fields = fields


class PipelineWriteSerializer(serializers.ModelSerializer):
    stage_id = serializers.PrimaryKeyRelatedField(
        queryset=Stage.objects.all(),
        source="stage",
        required=False,
    )
    owner_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source="owner",
        required=False,
        allow_null=True,
    )

    class Meta:
        model = Pipeline
        fields = (
            "id",
            "key",
            "title",
            "description",
            "counterparty",
            "stage_id",
            "owner_id",
        )
        read_only_fields = ("id", "key")

    def create(self, validated_data):
        request = self.context.get("request")
        user = getattr(request, "user", None) if request else None
        if user is not None and user.is_authenticated:
            validated_data.setdefault("created_by", user)
            validated_data.setdefault("owner", user)
        if "stage" not in validated_data:
            stage = Stage.objects.order_by("order").first()
            if stage is None:
                raise serializers.ValidationError(
                    {"stage_id": "No stages have been seeded."}
                )
            validated_data["stage"] = stage
        return super().create(validated_data)


class PipelineMoveSerializer(serializers.Serializer):
    stage_id = serializers.IntegerField()
    position = serializers.FloatField(required=False)
    before_id = serializers.IntegerField(required=False, allow_null=True)
    after_id = serializers.IntegerField(required=False, allow_null=True)
