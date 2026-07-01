"""Request serializers for the Drive API (no models — plain Serializers)."""

from rest_framework import serializers


class UploadUrlRequestSerializer(serializers.Serializer):
    path = serializers.CharField(max_length=1024, help_text="Destination key, e.g. 'docs/spec.pdf'")
    content_type = serializers.CharField(
        max_length=255, required=False, default="application/octet-stream"
    )


class DeleteRequestSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=1024)
