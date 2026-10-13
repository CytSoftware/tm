from __future__ import annotations

from rest_framework import serializers

from .models import Report
from .services import report_url


class ReportSerializer(serializers.ModelSerializer):
    """Metadata only. The detail view and ``get_report`` add ``html``."""

    key = serializers.CharField(read_only=True)
    project = serializers.SerializerMethodField()
    created_by = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()

    class Meta:
        model = Report
        fields = ["key", "title", "summary", "project", "created_by", "created_at", "url"]

    def get_project(self, obj):
        p = obj.project
        return p and {"id": p.id, "prefix": p.prefix, "name": p.name, "color": p.color}

    def get_created_by(self, obj):
        return obj.created_by and obj.created_by.get_username()

    def get_url(self, obj):
        return report_url(obj)


class ReportDetailSerializer(ReportSerializer):
    class Meta(ReportSerializer.Meta):
        fields = [*ReportSerializer.Meta.fields, "html"]
