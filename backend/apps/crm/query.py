"""Shared contact query helpers.

Single source of truth for filtering and sorting contacts, used by both the
DRF viewset and the MCP tools (mirroring ``apps.tasks.query`` and
``apps.pipelines.query``).

Filter shape::

    {
        "search": "acme",        # icontains across name/email/company/notes
        "country": "FR",         # ISO-2, exact (case-insensitive)
        "city": "Paris",         # exact (case-insensitive)
        "labels": [1, "Lead"],   # M2M intersection (all required)
        "has_email": True,
        "has_phone": True,
        "has_linkedin": True,
        "has_website": True,
    }

Sort entries: ``[{"field": "company", "dir": "asc"}, ...]``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from django.db.models import Q, QuerySet

from .models import Contact


SORTABLE_FIELDS = {
    "created_at",
    "updated_at",
    "company",
    "first_name",
    "last_name",
    "email",
    "country",
    "city",
    "industry",
    "job_title",
    "key",
}


def base_contact_queryset() -> QuerySet[Contact]:
    """Pre-joined queryset with labels prefetched for efficient list rendering."""
    return (
        Contact.objects.select_related("created_by", "created_by__profile")
        .prefetch_related("labels")
    )


def _coerce_str_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Iterable):
        return [str(v) for v in value if v is not None]
    return []


def apply_contact_filters(
    qs: QuerySet[Contact],
    filters: Mapping[str, Any] | None,
    *,
    requesting_user=None,
) -> QuerySet[Contact]:
    if not filters:
        return qs

    if search := filters.get("search"):
        if isinstance(search, str) and (stripped := search.strip()):
            for word in stripped.split():
                qs = qs.filter(
                    Q(key__icontains=word)
                    | Q(first_name__icontains=word)
                    | Q(last_name__icontains=word)
                    | Q(email__icontains=word)
                    | Q(company__icontains=word)
                    | Q(industry__icontains=word)
                    | Q(job_title__icontains=word)
                    | Q(phone__icontains=word)
                    | Q(notes__icontains=word)
                )

    if (country := filters.get("country")) not in (None, ""):
        codes = [c.upper()[:2] for c in _coerce_str_list(country) if c]
        if codes:
            if len(codes) == 1:
                qs = qs.filter(country__iexact=codes[0])
            else:
                qs = qs.filter(country__in=codes)

    if (city := filters.get("city")) not in (None, ""):
        cities = _coerce_str_list(city)
        if cities:
            if len(cities) == 1:
                qs = qs.filter(city__iexact=cities[0])
            else:
                qs = qs.filter(city__in=cities)

    # Free-text classification fields — substring match is the right call
    # here because typos / variants ("Software Eng." vs "Software Engineer")
    # would otherwise be silently filtered out.
    if (industry := filters.get("industry")) not in (None, ""):
        if isinstance(industry, str):
            qs = qs.filter(industry__icontains=industry.strip())

    if (job_title := filters.get("job_title")) not in (None, ""):
        if isinstance(job_title, str):
            qs = qs.filter(job_title__icontains=job_title.strip())

    label_values = filters.get("labels")
    if label_values:
        if not isinstance(label_values, (list, tuple)):
            label_values = [label_values]
        ids: list[int] = []
        names: list[str] = []
        for v in label_values:
            if isinstance(v, int):
                ids.append(v)
            elif isinstance(v, str):
                if v.isdigit():
                    ids.append(int(v))
                else:
                    names.append(v)
        # Intersection: every selected label must be attached. Chain filters
        # individually rather than ``__in=...`` (which is union semantics).
        for lid in ids:
            qs = qs.filter(labels__id=lid)
        for ln in names:
            qs = qs.filter(labels__name__iexact=ln)

    he = filters.get("has_email")
    if he is True:
        qs = qs.exclude(email="")
    elif he is False:
        qs = qs.filter(email="")

    hp = filters.get("has_phone")
    if hp is True:
        qs = qs.exclude(phone="")
    elif hp is False:
        qs = qs.filter(phone="")

    # JSONField boolean filters. ``__has_key`` works on SQLite ≥ 3.38 (Django
    # JSONField uses json_extract under the hood) and is the cheap way to
    # ask "does this contact have a LinkedIn URL recorded".
    hl = filters.get("has_linkedin")
    if hl is True:
        qs = qs.filter(socials__has_key="linkedin")
    elif hl is False:
        qs = qs.exclude(socials__has_key="linkedin")

    hw = filters.get("has_website")
    if hw is True:
        # Non-empty list: exclude rows whose websites is [] or null.
        qs = qs.exclude(websites=[]).exclude(websites__isnull=True)
    elif hw is False:
        qs = qs.filter(Q(websites=[]) | Q(websites__isnull=True))

    return qs.distinct()


def apply_contact_sort(
    qs: QuerySet[Contact],
    sort: list[Mapping[str, str]] | None,
) -> QuerySet[Contact]:
    if not sort:
        return qs.order_by("-created_at", "-id")

    order_fields: list[str] = []
    for entry in sort:
        field = entry.get("field")
        direction = (entry.get("dir") or "asc").lower()
        if not field or field not in SORTABLE_FIELDS:
            continue
        prefix = "-" if direction == "desc" else ""
        order_fields.append(f"{prefix}{field}")

    if not order_fields:
        return qs.order_by("-created_at", "-id")
    return qs.order_by(*order_fields, "id")


def filter_and_sort_contacts(
    filters: Mapping[str, Any] | None = None,
    sort: list[Mapping[str, str]] | None = None,
    *,
    requesting_user=None,
    base: QuerySet[Contact] | None = None,
) -> QuerySet[Contact]:
    qs = base if base is not None else base_contact_queryset()
    qs = apply_contact_filters(qs, filters, requesting_user=requesting_user)
    qs = apply_contact_sort(qs, sort)
    return qs
