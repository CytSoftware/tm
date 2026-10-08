"""Request serializers for the Drive API (no models — plain Serializers)."""

from rest_framework import serializers


class UploadUrlRequestSerializer(serializers.Serializer):
    path = serializers.CharField(max_length=1024, help_text="Destination key, e.g. 'docs/spec.pdf'")
    content_type = serializers.CharField(
        max_length=255, required=False, default="application/octet-stream"
    )


class DeleteRequestSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=1024)


class FolderRequestSerializer(serializers.Serializer):
    parent = serializers.CharField(max_length=1024, help_text="Folder to create it in, e.g. 'mowafeq/sales/'")
    name = serializers.CharField(max_length=128)


class MoveRequestSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=1024, help_text="File, or folder ending in '/'")
    to = serializers.CharField(max_length=1024, help_text="Destination folder")


class ShareRequestSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=1024, help_text="File, or folder ending in '/'")
    user_ids = serializers.ListField(child=serializers.IntegerField(), allow_empty=True)
