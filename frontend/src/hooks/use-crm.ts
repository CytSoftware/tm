"use client";

/**
 * CRM data hooks.
 *
 * Leads sit on a fixed board; each has a thread of updates (call, message,
 * meeting…) tagging their people and ours. What they need next is a task the
 * update files in the lead's project. People/companies are the meetings
 * app's entities. See docs/plans/crm.md.
 *
 * Every mutation invalidates the whole ["crm"] namespace: one update moves
 * the lead card, the thread, the activity feed and the contact lists
 * together. Writes that touch a next step also invalidate the task caches.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import {
  crmActivityKey,
  crmContactKey,
  crmContactsKey,
  crmLeadKey,
  crmLeadsKey,
  crmProjectsKey,
} from "@/lib/query-keys";
import type { User } from "@/lib/types";

export type EntityKind = "person" | "company";

export type EntityRef = {
  id: number;
  kind: EntityKind;
  name: string;
  position?: string;
  website?: string;
};

/** One of our businesses (a TM project) — what the CRM is scoped by. */
export type ProjectRef = { id: number; prefix: string; name: string; color: string };

export type LeadStage = "new" | "discovery" | "demo" | "pilot" | "proposal" | "won" | "lost";

export type UpdateKind = "note" | "message" | "call" | "email" | "meeting";

export type Contact = {
  id: number;
  kind: EntityKind;
  name: string;
  slug: string;
  aliases: string[];
  position: string;
  company: EntityRef | null;
  emails: string[];
  phone: string;
  linkedin_url: string;
  website: string;
  wiki_slug: string;
  last_update: { at: string; kind: UpdateKind; body: string } | null;
  /** Company roll-ups; 0 for people. */
  people_count: number;
  open_lead_count: number;
  created_at: string;
};

export type Lead = {
  key: string;
  title: string;
  stage: LeadStage;
  company: EntityRef | null;
  project: ProjectRef | null;
  notes: string;
  lost_reason: string;
  position: number;
  closed_at: string | null;
  /** Soonest open task its updates filed. */
  next_step: { key: string; title: string; due_at: string | null } | null;
  last_update_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Step = {
  key: string;
  title: string;
  due_at: string | null;
  is_open: boolean;
  assignees: User[];
};

export type Update = {
  id: number;
  kind: UpdateKind;
  body: string;
  /** What they need next, filed by this update. */
  task: Step | null;
  occurred_at: string;
  lead: { key: string; title: string; company: EntityRef | null } | null;
  people: (EntityRef & { company: string | null })[];
  users: User[];
  meeting: {
    key: string;
    title: string;
    gshr_url: string;
    duration_seconds: number | null;
  } | null;
  created_by: User | null;
  created_at: string;
};

export type LeadDetail = Lead & {
  people: EntityRef[];
  /** Open next steps, soonest first. */
  steps: Step[];
  updates: Update[];
};

export type ContactDetail = Contact & {
  people: Contact[];
  leads: Lead[];
  updates: Update[];
  meeting_count: number;
};

export type ContactFilters = {
  search?: string;
  kind?: string;
  company?: string;
  /** Every entity, not just the ones in the CRM. */
  all?: string;
  /** Project prefix ("MOW") — the CRM scope. */
  project?: string;
};

type Page<T> = { count: number; results: T[] };

/** The browser's IANA zone — a next step is due 09:00 on its day there. */
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Qatar";

const stableKey = (f: Record<string, string | undefined>) =>
  JSON.stringify(
    Object.entries(f)
      .filter(([, v]) => v)
      .sort(),
  );

// ── Reads ───────────────────────────────────────────────────────────────────

export function useCrmActivity(days: number, project = "", enabled = true) {
  return useQuery({
    queryKey: crmActivityKey(days, project),
    queryFn: () => apiFetch<Update[]>("/api/crm/activity/", { query: { days, project } }),
    enabled,
  });
}

/** Projects that have leads — the scope switcher's options. */
export function useCrmProjects() {
  return useQuery({
    queryKey: crmProjectsKey(),
    queryFn: () => apiFetch<ProjectRef[]>("/api/crm/projects/"),
  });
}

export function useContacts(filters: ContactFilters, enabled = true) {
  return useQuery({
    queryKey: crmContactsKey(stableKey(filters)),
    queryFn: () =>
      apiFetch<Page<Contact>>("/api/crm/contacts/", { query: { ...filters, limit: 1000 } }),
    select: (page) => page.results,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useContact(id: number | null) {
  return useQuery({
    queryKey: id ? crmContactKey(id) : ["crm", "contact", "__none__"],
    queryFn: () => apiFetch<ContactDetail>(`/api/crm/contacts/${id}/`),
    enabled: !!id,
  });
}

export function useLeads(project = "", enabled = true) {
  return useQuery({
    queryKey: crmLeadsKey(project),
    queryFn: () =>
      apiFetch<Page<Lead>>("/api/crm/leads/", { query: { project, limit: 1000 } }),
    select: (page) => page.results,
    enabled,
  });
}

export function useLead(key: string | null) {
  return useQuery({
    queryKey: key ? crmLeadKey(key) : ["crm", "lead", "__none__"],
    queryFn: () => apiFetch<LeadDetail>(`/api/crm/leads/${key}/`),
    enabled: !!key,
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────

function useCrmWrite<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { tasks?: boolean; meetings?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm"] });
      if (opts.tasks) {
        for (const root of ["tasks", "tasks-infinite", "task"])
          qc.invalidateQueries({ queryKey: [root] });
      }
      if (opts.meetings) qc.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

export type ContactWrite = Partial<{
  kind: EntityKind;
  name: string;
  position: string;
  company: string | null;
  emails: string[];
  phone: string;
  linkedin_url: string;
  website: string;
  wiki_slug: string;
}>;

export function useCreateContact() {
  return useCrmWrite(
    (body: ContactWrite) =>
      apiFetch<ContactDetail>("/api/crm/contacts/", { method: "POST", body }),
    { meetings: true },
  );
}

export function useUpdateContact() {
  return useCrmWrite(
    ({ id, ...body }: ContactWrite & { id: number }) =>
      apiFetch<ContactDetail>(`/api/crm/contacts/${id}/`, { method: "PATCH", body }),
    { meetings: true },
  );
}

export type LeadWrite = Partial<{
  title: string;
  stage: LeadStage;
  company: number | null;
  project: number | null;
  notes: string;
  lost_reason: string;
}>;

export function useCreateLead() {
  return useCrmWrite((body: LeadWrite) =>
    apiFetch<LeadDetail>("/api/crm/leads/", { method: "POST", body }),
  );
}

export function useUpdateLead() {
  return useCrmWrite(({ key, ...body }: LeadWrite & { key: string }) =>
    apiFetch<LeadDetail>(`/api/crm/leads/${key}/`, { method: "PATCH", body }),
  );
}

export function useDeleteLead() {
  return useCrmWrite((key: string) =>
    apiFetch(`/api/crm/leads/${key}/`, { method: "DELETE" }),
  );
}

/** Optimistic: the card jumps columns immediately, then the server's
 *  position wins on refetch. Rolls back on error. */
export function useMoveLead(project = "") {
  const qc = useQueryClient();
  const key = crmLeadsKey(project);
  return useMutation({
    mutationFn: ({ leadKey, stage, index }: { leadKey: string; stage: LeadStage; index?: number }) =>
      apiFetch<LeadDetail>(`/api/crm/leads/${leadKey}/move/`, {
        method: "POST",
        body: { stage, index },
      }),
    onMutate: async ({ leadKey, stage }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Page<Lead>>(key);
      if (prev) {
        qc.setQueryData<Page<Lead>>(key, {
          ...prev,
          results: prev.results.map((l) => (l.key === leadKey ? { ...l, stage } : l)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["crm"] }),
  });
}

export type UpdateWrite = {
  kind?: UpdateKind;
  body: string;
  /** Filed as a task in the lead's project. */
  next_step?: string;
  next_due?: string | null;
  next_assignee?: number | null;
  occurred_at?: string;
  lead?: string | null;
  people?: number[];
  users?: number[];
  meeting?: string | null;
};

export function usePostUpdate() {
  return useCrmWrite(
    (body: UpdateWrite) =>
      apiFetch<Update>("/api/crm/updates/", { method: "POST", body: { tz: browserTz(), ...body } }),
    { meetings: true, tasks: true },
  );
}

export function useEditUpdate() {
  return useCrmWrite(({ id, ...body }: Partial<UpdateWrite> & { id: number }) =>
    apiFetch<Update>(`/api/crm/updates/${id}/`, { method: "PATCH", body }),
  );
}

export function useDeleteUpdate() {
  return useCrmWrite((id: number) =>
    apiFetch(`/api/crm/updates/${id}/`, { method: "DELETE" }),
  );
}

export function useSetStepDone() {
  return useCrmWrite(
    ({ key, done }: { key: string; done: boolean }) =>
      apiFetch<Step>(`/api/crm/steps/${key}/`, { method: "POST", body: { done } }),
    { tasks: true },
  );
}
