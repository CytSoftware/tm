"use client";

/**
 * TanStack Query hooks for the CRM.
 *
 * Pagination, filtering, sorting, and search are all server-side — the hooks
 * just shuttle state into query params and surface the paginated response.
 * No realtime broadcast in v1, so there's no WebSocket equivalent of
 * `lib/ws.ts` here.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch, ApiError } from "@/lib/api";
import {
  contactKey,
  contactLabelsKey,
  contactListKey,
} from "@/lib/query-keys";
import type {
  Contact,
  ContactFilters,
  ContactImportPreview,
  ContactImportResult,
  ContactLabel,
  ContactListResponse,
  ContactSortField,
  SocialKey,
} from "@/lib/types";
import { EMPTY_CONTACT_FILTERS } from "@/lib/types";

export const DEFAULT_CONTACT_PAGE_SIZE = 50;
export const MAX_CONTACT_PAGE_SIZE = 200;

// ─────────────────────────────────────────────────────────────────────────
// Filters → URL params
// ─────────────────────────────────────────────────────────────────────────

export function contactFiltersCacheKey(f: ContactFilters): string {
  return JSON.stringify({
    search: f.search.trim(),
    country: f.country.trim().toUpperCase(),
    city: f.city.trim(),
    industry: f.industry.trim(),
    jobTitle: f.jobTitle.trim(),
    labelIds: [...f.labelIds].sort((a, b) => a - b),
    hasEmail: f.hasEmail,
    hasPhone: f.hasPhone,
    hasLinkedin: f.hasLinkedin,
    hasWebsite: f.hasWebsite,
  });
}

function buildContactQS(args: {
  filters: ContactFilters;
  sortField: ContactSortField | null;
  sortDir: "asc" | "desc" | null;
  page: number;
  pageSize: number;
}): string {
  const { filters, sortField, sortDir, page, pageSize } = args;
  const params = new URLSearchParams();
  const safePageSize = Math.min(
    Math.max(1, pageSize),
    MAX_CONTACT_PAGE_SIZE,
  );
  params.set("limit", String(safePageSize));
  params.set("offset", String(Math.max(0, (page - 1) * safePageSize)));

  const search = filters.search.trim();
  if (search) params.set("search", search);
  const country = filters.country.trim().toUpperCase();
  if (country) params.set("country", country);
  const city = filters.city.trim();
  if (city) params.set("city", city);
  const industry = filters.industry.trim();
  if (industry) params.set("industry", industry);
  const jobTitle = filters.jobTitle.trim();
  if (jobTitle) params.set("job_title", jobTitle);
  for (const id of filters.labelIds) params.append("label", String(id));
  if (filters.hasEmail !== null) params.set("has_email", String(filters.hasEmail));
  if (filters.hasPhone !== null) params.set("has_phone", String(filters.hasPhone));
  if (filters.hasLinkedin !== null)
    params.set("has_linkedin", String(filters.hasLinkedin));
  if (filters.hasWebsite !== null)
    params.set("has_website", String(filters.hasWebsite));

  if (sortField) {
    params.set("sort_field", sortField);
    params.set("sort_dir", sortDir === "desc" ? "desc" : "asc");
  }
  return params.toString();
}

// ─────────────────────────────────────────────────────────────────────────
// Labels — small read-only set (per session). CRUD via separate hooks below.
// ─────────────────────────────────────────────────────────────────────────

export function useContactLabelsQuery() {
  return useQuery({
    queryKey: contactLabelsKey(),
    queryFn: () => apiFetch<ContactLabel[]>("/api/contact-labels/"),
    staleTime: 5 * 60_000,
  });
}

export type LabelPayload = { name: string; color?: string };

export function useCreateContactLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: LabelPayload) =>
      apiFetch<ContactLabel>("/api/contact-labels/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: contactLabelsKey() });
    },
  });
}

export function useUpdateContactLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: LabelPayload & { id: number }) =>
      apiFetch<ContactLabel>(`/api/contact-labels/${id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: contactLabelsKey() });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}

export function useDeleteContactLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/contact-labels/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: contactLabelsKey() });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// List query — paginated table view.
// ─────────────────────────────────────────────────────────────────────────

export type ContactListParams = {
  filters: ContactFilters;
  sortField: ContactSortField | null;
  sortDir: "asc" | "desc" | null;
  page: number;
  pageSize: number;
};

export function useContactsQuery(params: ContactListParams) {
  const filtersKey = contactFiltersCacheKey(params.filters);
  return useQuery({
    queryKey: contactListKey(
      filtersKey,
      params.sortField,
      params.sortDir,
      params.page,
      params.pageSize,
    ),
    queryFn: () => {
      const qs = buildContactQS(params);
      return apiFetch<ContactListResponse>(`/api/contacts/?${qs}`);
    },
    placeholderData: (prev) => prev,
  });
}

export function useContactQuery(key: string | null) {
  return useQuery({
    queryKey: key ? contactKey(key) : ["contact", "__none__"],
    queryFn: () => apiFetch<Contact>(`/api/contacts/${key}/`),
    enabled: !!key,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────

function invalidateContacts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["contacts"] });
}

export type ContactWritePayload = {
  company?: string;
  first_name?: string;
  last_name?: string;
  industry?: string;
  job_title?: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  websites?: string[];
  socials?: Partial<Record<SocialKey, string>>;
  label_ids?: number[];
  notes?: string;
};

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ContactWritePayload) =>
      apiFetch<Contact>("/api/contacts/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => invalidateContacts(qc),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      ...payload
    }: ContactWritePayload & { key: string }) =>
      apiFetch<Contact>(`/api/contacts/${key}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: (_contact, variables) => {
      invalidateContacts(qc);
      qc.invalidateQueries({ queryKey: contactKey(variables.key) });
    },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<void>(`/api/contacts/${key}/`, { method: "DELETE" }),
    onSuccess: () => invalidateContacts(qc),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Bulk operations
// ─────────────────────────────────────────────────────────────────────────

/** Translate the in-memory ContactFilters shape into the dict the backend
 *  ``apply_contact_filters`` helper expects. Mirrors what ``buildContactQS``
 *  emits as query params, but as a JSON body for the bulk endpoints. */
export function contactFiltersToBackendDict(
  f: ContactFilters,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const search = f.search.trim();
  if (search) out.search = search;
  const country = f.country.trim().toUpperCase();
  if (country) out.country = country;
  const city = f.city.trim();
  if (city) out.city = city;
  const industry = f.industry.trim();
  if (industry) out.industry = industry;
  const jobTitle = f.jobTitle.trim();
  if (jobTitle) out.job_title = jobTitle;
  if (f.labelIds.length) out.labels = f.labelIds;
  if (f.hasEmail !== null) out.has_email = f.hasEmail;
  if (f.hasPhone !== null) out.has_phone = f.hasPhone;
  if (f.hasLinkedin !== null) out.has_linkedin = f.hasLinkedin;
  if (f.hasWebsite !== null) out.has_website = f.hasWebsite;
  return out;
}

/** Either an explicit list of keys, or "everything matching the filter". */
export type BulkSelector =
  | { keys: string[] }
  | { select_all: true; filters: Record<string, unknown> };

export function useBulkDeleteContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BulkSelector) =>
      apiFetch<{ deleted: number }>("/api/contacts/bulk-delete/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => invalidateContacts(qc),
  });
}

export type BulkLabelPayload = BulkSelector & {
  label_ids: number[];
  action: "add" | "remove";
};

export function useBulkLabelContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BulkLabelPayload) =>
      apiFetch<{ affected: number }>("/api/contacts/bulk-label/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => invalidateContacts(qc),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// CSV import (preview + apply) and export
// ─────────────────────────────────────────────────────────────────────────

export function useContactImportPreview() {
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiFetch<ContactImportPreview>(
        "/api/contacts/import-preview/",
        {
          method: "POST",
          body: form,
        },
      );
    },
  });
}

export type ImportApplyPayload = {
  token: string;
  mapping: Record<string, string>;
  dedupe: "email" | "name+company" | "none";
  on_conflict: "skip" | "update";
};

export function useContactImportApply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ImportApplyPayload) =>
      apiFetch<ContactImportResult>("/api/contacts/import-apply/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      invalidateContacts(qc);
      qc.invalidateQueries({ queryKey: contactLabelsKey() });
    },
  });
}

/**
 * Trigger a CSV download for the currently filtered queryset.
 *
 * The export endpoint streams; we drive the browser's native download via a
 * temporary anchor + `URL.createObjectURL` so the user gets a "Save as…"
 * dialog rather than a navigation away from the CRM page.
 */
export async function triggerContactExport(filters: ContactFilters): Promise<void> {
  const qs = buildContactQS({
    filters,
    sortField: null,
    sortDir: null,
    page: 1,
    pageSize: 1, // not used on the server export path, but keeps the shape happy
  });
  // Rebuild without limit/offset for export — server export ignores them.
  const cleaned = new URLSearchParams(qs);
  cleaned.delete("limit");
  cleaned.delete("offset");

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const url = `${apiUrl}/api/contacts/export/${cleaned.toString() ? `?${cleaned}` : ""}`;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ApiError(
      `Export failed (${response.status})`,
      response.status,
      text,
    );
  }
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = "contacts.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// Re-export so consumers don't need a second import statement.
export { EMPTY_CONTACT_FILTERS };
