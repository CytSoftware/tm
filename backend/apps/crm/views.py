"""DRF viewsets for CRM contacts and labels.

All filtering / sorting / pagination happens server-side via the shared
``query.py`` helpers — the same module the MCP tools use, so behaviour stays
consistent across consumers.
"""

from __future__ import annotations

from django.db import transaction
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from .csv_io import apply_import, preview_import_file, stream_csv_export
from .models import Contact, ContactLabel
from .query import (
    apply_contact_filters,
    apply_contact_sort,
    base_contact_queryset,
)
from .serializers import (
    ContactLabelSerializer,
    ContactReadSerializer,
    ContactWriteSerializer,
    ImportApplySerializer,
)


# Hard cap on how many keys / label_ids a single bulk request can carry.
# Protects the DB from a runaway client and gives the frontend a clean
# "split this in two requests" boundary.
_BULK_MAX_KEYS = 1000
_BULK_MAX_LABEL_IDS = 50


class ContactLabelViewSet(viewsets.ModelViewSet):
    """CRUD on contact labels. The set is small — no pagination."""

    queryset = ContactLabel.objects.all().order_by("name")
    serializer_class = ContactLabelSerializer
    pagination_class = None


def _extract_filters(params) -> dict:
    filters: dict = {}
    if (search := params.get("search")) is not None and search != "":
        filters["search"] = search
    if (country := params.get("country")) not in (None, ""):
        # Allow either repeated ?country=US&country=FR or single value
        many = [c for c in params.getlist("country") if c]
        filters["country"] = many if len(many) > 1 else country
    if (city := params.get("city")) not in (None, ""):
        many_c = [c for c in params.getlist("city") if c]
        filters["city"] = many_c if len(many_c) > 1 else city
    if (industry := params.get("industry")) not in (None, ""):
        filters["industry"] = industry
    if (job_title := params.get("job_title")) not in (None, ""):
        filters["job_title"] = job_title
    label_values = [v for v in params.getlist("label") if v]
    if label_values:
        filters["labels"] = label_values
    if (he := params.get("has_email")) in ("true", "false"):
        filters["has_email"] = he == "true"
    if (hp := params.get("has_phone")) in ("true", "false"):
        filters["has_phone"] = hp == "true"
    if (hl := params.get("has_linkedin")) in ("true", "false"):
        filters["has_linkedin"] = hl == "true"
    if (hw := params.get("has_website")) in ("true", "false"):
        filters["has_website"] = hw == "true"
    return filters


_SORT_DIRS = {"asc", "desc"}


def _extract_sort(params) -> list | None:
    field = params.get("sort_field")
    if not field:
        return None
    direction = (params.get("sort_dir") or "asc").lower()
    if direction not in _SORT_DIRS:
        direction = "asc"
    return [{"field": field, "dir": direction}]


class ContactViewSet(viewsets.ModelViewSet):
    """All contact CRUD. Lookup is by the human key (``CONT-0001``)."""

    lookup_field = "key"
    lookup_value_regex = r"[A-Za-z0-9\-]+"

    def get_queryset(self):
        qs = base_contact_queryset()
        # Detail / write actions can skip the filter/sort layer — they look
        # up by key, and DRF resolves that against the raw queryset.
        if self.action in {"list", "export"}:
            params = self.request.query_params
            filters = _extract_filters(params)
            sort = _extract_sort(params)
            qs = apply_contact_filters(
                qs, filters, requesting_user=self.request.user
            )
            qs = apply_contact_sort(qs, sort)
        return qs

    def get_serializer_class(self):
        if self.action in {"list", "retrieve"}:
            return ContactReadSerializer
        return ContactWriteSerializer

    # ── CSV import: preview ───────────────────────────────────────────────

    @action(
        detail=False,
        methods=["post"],
        url_path="import-preview",
        parser_classes=[MultiPartParser, FormParser],
    )
    def import_preview(self, request):
        """Step 1 of the import wizard.

        Accepts a multipart upload (``file`` field) of either a CSV or an
        XLSX workbook, saves it to ``MEDIA_ROOT/imports/<token>.<ext>``,
        and returns a preview the frontend wizard can render.
        """
        uploaded = request.FILES.get("file")
        if uploaded is None:
            raise ValidationError({"file": "No file uploaded."})
        return Response(preview_import_file(uploaded))

    # ── CSV import: apply ─────────────────────────────────────────────────

    @action(
        detail=False,
        methods=["post"],
        url_path="import-apply",
    )
    def import_apply(self, request):
        """Step 2 of the import wizard.

        Body shape::

            {
              "token": "<uuid>",
              "mapping": {"First Name": "first_name", ...},
              "dedupe": "email" | "name+company" | "none",
              "on_conflict": "skip" | "update"
            }
        """
        payload = ImportApplySerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        v = payload.validated_data
        result = apply_import(
            v["token"],
            mapping=v["mapping"],
            dedupe=v.get("dedupe", "email"),
            on_conflict=v.get("on_conflict", "skip"),
            user=request.user,
        )
        return Response(result, status=status.HTTP_200_OK)

    # ── CSV export ───────────────────────────────────────────────────────

    @action(
        detail=False,
        methods=["get"],
        url_path="export",
    )
    def export(self, request):
        """Stream the current filtered queryset as a CSV download."""
        return stream_csv_export(self.get_queryset())

    # ── Bulk operations ──────────────────────────────────────────────────

    @action(
        detail=False,
        methods=["post"],
        url_path="bulk-delete",
    )
    def bulk_delete(self, request):
        """Delete contacts in bulk.

        Two modes:

        * **By keys**::

              {"keys": ["CONT-0001", "CONT-0002", ...]}

        * **All matching the current filter** (used when the user clicks
          "Select all N matching" in the UI)::

              {"select_all": true, "filters": {...}}

          ``filters`` shape matches what ``apply_contact_filters`` expects
          (``search``, ``country``, ``city``, ``industry``, ``job_title``,
          ``labels``, ``has_email``, ``has_phone``, ``has_linkedin``,
          ``has_website``).

        Returns ``{"deleted": N}``.
        """
        if request.data.get("select_all"):
            qs = self._queryset_from_bulk_filters(request)
            # Count first so the response reports the contact count rather
            # than ``qs.delete()``'s "total rows incl. M2M intermediates"
            # (which would inflate the number once labels are attached).
            count = qs.count()
            qs.delete()
            return Response({"deleted": count})

        clean_keys = self._validate_keys(request.data.get("keys"))
        if not clean_keys:
            return Response({"deleted": 0})

        before = Contact.objects.filter(key__in=clean_keys).count()
        Contact.objects.filter(key__in=clean_keys).delete()
        return Response({"deleted": before})

    @action(
        detail=False,
        methods=["post"],
        url_path="bulk-label",
    )
    def bulk_label(self, request):
        """Attach or detach labels on a batch of contacts.

        Same two modes as ``bulk-delete`` for selecting the target rows::

            {"keys": [...], "label_ids": [1, 2], "action": "add" | "remove"}
            {"select_all": true, "filters": {...}, "label_ids": [...], "action": "add" | "remove"}
        """
        label_ids = request.data.get("label_ids")
        mode = request.data.get("action", "add")
        if not isinstance(label_ids, list):
            raise ValidationError({"label_ids": "Must be a list."})
        if mode not in ("add", "remove"):
            raise ValidationError({"action": 'Must be "add" or "remove".'})
        if len(label_ids) > _BULK_MAX_LABEL_IDS:
            raise ValidationError(
                {
                    "label_ids": (
                        f"Too many labels ({len(label_ids)} > "
                        f"{_BULK_MAX_LABEL_IDS})."
                    )
                }
            )
        clean_ids = [
            int(i) for i in label_ids if isinstance(i, (int, str)) and str(i).isdigit()
        ]
        if not clean_ids:
            return Response({"affected": 0})

        labels = list(ContactLabel.objects.filter(id__in=clean_ids))
        if not labels:
            return Response({"affected": 0})

        if request.data.get("select_all"):
            contacts = self._queryset_from_bulk_filters(request).only("id")
        else:
            clean_keys = self._validate_keys(request.data.get("keys"))
            if not clean_keys:
                return Response({"affected": 0})
            contacts = Contact.objects.filter(key__in=clean_keys).only("id")

        # Cap iteration so a runaway "all matching" can't tie up the worker.
        # Hard match to MAX_IMPORT_ROWS keeps us in the same operational class
        # as the importer.
        from .csv_io import MAX_IMPORT_ROWS  # local: avoids module-load cycle

        affected = 0
        with transaction.atomic():
            for c in contacts.iterator(chunk_size=500):
                if mode == "add":
                    c.labels.add(*labels)
                else:
                    c.labels.remove(*labels)
                affected += 1
                if affected >= MAX_IMPORT_ROWS:
                    break

        return Response({"affected": affected})

    # ── Bulk helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _validate_keys(raw) -> list[str]:
        if raw is None:
            raise ValidationError({"keys": "Required when select_all is false."})
        if not isinstance(raw, list):
            raise ValidationError({"keys": "Must be a list of contact keys."})
        if len(raw) > _BULK_MAX_KEYS:
            raise ValidationError(
                {"keys": f"Too many keys ({len(raw)} > {_BULK_MAX_KEYS})."}
            )
        return list({str(k) for k in raw if isinstance(k, str)})

    def _queryset_from_bulk_filters(self, request):
        """Resolve a queryset from the ``filters`` body of a bulk-* request.

        Mirrors the list endpoint's filter handling, but reads the dict from
        the JSON body rather than query params.
        """
        filters_dict = request.data.get("filters") or {}
        if not isinstance(filters_dict, dict):
            raise ValidationError({"filters": "Must be an object."})
        return apply_contact_filters(
            base_contact_queryset(),
            filters_dict,
            requesting_user=request.user,
        )
