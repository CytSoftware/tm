"""DRF serializers for CRM contacts."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers

from .models import ALLOWED_SOCIAL_KEYS, Contact, ContactLabel

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
        raw = getattr(profile, "effective_avatar_url", None) or ""
        if not raw:
            return ""
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        request = self.context.get("request")
        if request is not None:
            return request.build_absolute_uri(raw)
        return raw


class ContactLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = ContactLabel
        fields = ("id", "name", "color", "created_at")
        read_only_fields = ("id", "created_at")


class ContactReadSerializer(serializers.ModelSerializer):
    labels = ContactLabelSerializer(many=True, read_only=True)
    created_by = _UserSlim(read_only=True)

    class Meta:
        model = Contact
        fields = (
            "id",
            "key",
            "company",
            "first_name",
            "last_name",
            "industry",
            "job_title",
            "email",
            "phone",
            "address_line1",
            "address_line2",
            "city",
            "region",
            "postal_code",
            "country",
            "websites",
            "socials",
            "labels",
            "notes",
            "created_by",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class ContactWriteSerializer(serializers.ModelSerializer):
    label_ids = serializers.PrimaryKeyRelatedField(
        queryset=ContactLabel.objects.all(),
        source="labels",
        many=True,
        required=False,
    )

    class Meta:
        model = Contact
        fields = (
            "id",
            "key",
            "company",
            "first_name",
            "last_name",
            "industry",
            "job_title",
            "email",
            "phone",
            "address_line1",
            "address_line2",
            "city",
            "region",
            "postal_code",
            "country",
            "websites",
            "socials",
            "label_ids",
            "notes",
        )
        read_only_fields = ("id", "key")

    # ── Field-level validation ────────────────────────────────────────────

    def validate_websites(self, value):
        if value is None:
            return []
        if not isinstance(value, list):
            raise serializers.ValidationError("Must be a list of URL strings.")
        out: list[str] = []
        for v in value:
            if isinstance(v, str):
                stripped = v.strip()
                if stripped:
                    out.append(stripped)
        return out

    def validate_socials(self, value):
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("Must be an object.")
        out: dict[str, str] = {}
        for k, v in value.items():
            if k not in ALLOWED_SOCIAL_KEYS:
                continue
            if not isinstance(v, str):
                continue
            stripped = v.strip()
            if stripped:
                out[k] = stripped
        return out

    def validate_country(self, value):
        if not isinstance(value, str):
            return ""
        return value.strip().upper()[:2]

    # ── Create attribution ────────────────────────────────────────────────

    def create(self, validated_data):
        request = self.context.get("request")
        user = getattr(request, "user", None) if request else None
        if user is not None and user.is_authenticated:
            validated_data.setdefault("created_by", user)
        return super().create(validated_data)


# ── CSV import payloads ──────────────────────────────────────────────────


class ImportApplySerializer(serializers.Serializer):
    """Body for ``POST /api/contacts/import-apply/``.

    ``mapping`` maps source CSV header → target field name. Target values can
    be:

    * a Contact field name (``"company"``, ``"first_name"``, ...)
    * ``"socials.linkedin"`` / ``"socials.twitter"`` / ``"socials.facebook"`` /
      ``"socials.instagram"``
    * ``"labels"`` — comma-separated values become labels (auto-create)
    * ``"websites"`` — comma-separated values appended to the URL list
    * ``"[ignore]"`` — column is skipped
    """

    token = serializers.CharField()
    mapping = serializers.DictField(child=serializers.CharField())
    dedupe = serializers.ChoiceField(
        choices=("email", "name+company", "none"),
        default="email",
        required=False,
    )
    on_conflict = serializers.ChoiceField(
        choices=("skip", "update"),
        default="skip",
        required=False,
    )
