"""django-filter backends for the task tracker.

The main filter logic lives in :mod:`apps.tasks.query`, so this module is
intentionally thin — it just exposes the common ad-hoc filters to DRF's
browsable API and query-string interface. Saved views bypass this filter set
entirely and go straight through ``query.apply_task_filters``.
"""

from __future__ import annotations

from django_filters import rest_framework as filters

from .models import Task


class TaskFilter(filters.FilterSet):
    project = filters.NumberFilter(field_name="project_id")
    column = filters.NumberFilter(field_name="column_id")
    assignee = filters.NumberFilter(
        field_name="assignees__id", distinct=True
    )
    priority = filters.CharFilter(field_name="priority")
    label = filters.NumberFilter(field_name="labels__id", distinct=True)
    search = filters.CharFilter(method="filter_search")

    class Meta:
        model = Task
        fields = ["project", "column", "assignee", "priority", "label"]

    def filter_search(self, queryset, name, value):
        if not value:
            return queryset
        return queryset.filter(key__icontains=value) | queryset.filter(
            title__icontains=value
        )
