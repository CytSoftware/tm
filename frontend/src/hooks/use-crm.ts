"use client";

/**
 * CRM data hooks.
 *
 * Contacts are the meetings app's people/companies with a `relationship`;
 * follow-ups are tasks in the CRM project; the timeline is derived server-side
 * (meetings + touchpoints + closed follow-ups). See docs/plans/crm.md.
 *
 * Every mutation invalidates the whole ["crm"] namespace: logging one call
 * moves the contact's last-contact date, the inbox, the timeline and the
 * company roll-up together. Follow-up writes also invalidate ["tasks"] since
 * they are tasks on the CRM project's board.
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
  crmDealKey,
  crmDealsKey,
  crmInboxKey,
  crmProjectsKey,
  crmPipelinesKey,
} from "@/lib/query-keys";
import type { User } from "@/lib/types";

export type Relationship =
  | "client"
  | "lead"
  | "partner"
  | "advisor"
  | "investor"
  | "other"
  | "internal";

export type EntityKind = "person" | "company";

export type EntityRef = { id: number; kind: EntityKind; name: string; website?: string };

/** One of our businesses (a TM project) — what the CRM is scoped by. */
export type ProjectRef = { id: number; prefix: string; name: string; color: string };

export type Contact = {
  id: number;
  kind: EntityKind;
  name: string;
  slug: string;
  aliases: string[];
  relationship: Relationship | "";
  owner: User | null;
  headline: string;
  company: EntityRef | null;
  emails: string[];
  projects: ProjectRef[];
  phone: string;
  whatsapp: string;
  linkedin_url: string;
  website: string;
  wiki_slug: string;
  last_contact_at: string | null;
  /** Newest meeting or touchpoint — what the list row previews. */
  last_activity:
    | { type: "meeting"; at: string; text: string }
    | { type: "touchpoint"; kind: TouchpointKind; at: string; text: string }
    | null;
  next_follow_up_at: string | null;
  next_follow_up_title: string | null;
  has_open_follow_up: boolean;
  /** Company roll-ups; 0 / null for people. */
  people_count: number;
  open_deal_count: number;
  open_deal_value: string | null;
  created_at: string;
};

export type FollowUp = {
  id: number;
  task_key: string;
  title: string;
  description: string;
  due_at: string | null;
  column: string | null;
  is_open: boolean;
  assignees: User[];
  entity: EntityRef;
  company: EntityRef | null;
  deal: { key: string; title: string } | null;
  created_at: string;
};

export type StageKind = "open" | "won" | "lost";

export type Stage = {
  id: number;
  name: string;
  kind: StageKind;
  position: number;
  deal_count: number;
};

export type Pipeline = {
  id: number;
  name: string;
  slug: string;
  position: number;
  stages: Stage[];
};

export type Deal = {
  key: string;
  title: string;
  pipeline: { id: number; name: string; slug: string };
  stage: { id: number; name: string; kind: StageKind };
  company: EntityRef | null;
  contacts: EntityRef[];
  owner: User | null;
  value: string | null;
  currency: string;
  project: ProjectRef | null;
  expected_close: string | null;
  notes: string;
  position: number;
  closed_at: string | null;
  lost_reason: string;
  created_at: string;
  updated_at: string;
};

export type TouchpointKind =
  | "email"
  | "call"
  | "whatsapp"
  | "calendar"
  | "note"
  | "other";

export type Touchpoint = {
  id: number;
  kind: TouchpointKind;
  direction: "in" | "out" | "";
  occurred_at: string;
  summary: string;
  entities: EntityRef[];
  deal: string | null;
  source: string;
  external_id: string;
  created_at: string;
};

export type TimelineItem =
  | {
      type: "meeting";
      at: string;
      title: string;
      summary: string;
      key: string;
      category: string;
      gshr_url: string;
      duration_seconds: number | null;
      people: string[];
      entities: EntityRef[];
    }
  | {
      type: "touchpoint";
      at: string;
      id: number;
      kind: TouchpointKind;
      direction: "in" | "out" | "";
      summary: string;
      source: string;
      deal: string | null;
      people: string[];
      entities: EntityRef[];
      created_by: string | null;
    }
  | {
      type: "follow_up";
      at: string;
      title: string;
      key: string;
      status: string;
      deal: string | null;
      entities: EntityRef[];
    };

export type ContactDetail = Contact & {
  people: Contact[];
  deals: Deal[];
  follow_ups: FollowUp[];
  meeting_count: number;
  timeline: TimelineItem[];
};

export type DealDetail = Deal & {
  follow_ups: FollowUp[];
  touchpoints: Touchpoint[];
};

export type Inbox = {
  today: string;
  buckets: Record<"overdue" | "today" | "week" | "later", FollowUp[]>;
  no_next_step: Contact[];
};

export type ContactFilters = {
  search?: string;
  relationship?: string;
  kind?: string;
  owner?: string;
  no_next_step?: string;
  sort?: string;
  /** Project prefix ("MOW") — the CRM scope. */
  project?: string;
};

type Page<T> = { count: number; results: T[] };

/** The browser's IANA zone — TM stores none per user. */
export const browserTz = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Qatar";

const stableKey = (f: Record<string, string | undefined>) =>
  JSON.stringify(
    Object.entries(f)
      .filter(([, v]) => v)
      .sort(),
  );

// ── Reads ───────────────────────────────────────────────────────────────────

export function useCrmInbox(owner: string, project = "") {
  return useQuery({
    queryKey: crmInboxKey(`${owner}|${project}`),
    queryFn: () =>
      apiFetch<Inbox>("/api/crm/inbox/", {
        query: { tz: browserTz(), owner, project },
      }),
  });
}

export function useCrmActivity(days: number, project = "", enabled = true) {
  return useQuery({
    queryKey: crmActivityKey(days, project),
    queryFn: () =>
      apiFetch<TimelineItem[]>("/api/crm/activity/", { query: { days, project } }),
    enabled,
  });
}

/** Projects the CRM is split by (any a contact or deal is tagged with). */
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
      apiFetch<Page<Contact>>("/api/crm/contacts/", {
        query: { ...filters, limit: 1000 },
      }),
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

const dealsKey = (pipeline: number | null, project: string) =>
  crmDealsKey(`${pipeline ?? ""}|${project}`);

export function useDeals(pipeline: number | null, project = "") {
  return useQuery({
    queryKey: dealsKey(pipeline, project),
    queryFn: () =>
      apiFetch<Page<Deal>>("/api/crm/deals/", {
        query: { pipeline: pipeline ?? undefined, project, limit: 1000 },
      }),
    select: (page) => page.results,
    enabled: pipeline != null,
  });
}

export function useDeal(key: string | null) {
  return useQuery({
    queryKey: key ? crmDealKey(key) : ["crm", "deal", "__none__"],
    queryFn: () => apiFetch<DealDetail>(`/api/crm/deals/${key}/`),
    enabled: !!key,
  });
}

export function usePipelines() {
  return useQuery({
    queryKey: crmPipelinesKey(),
    queryFn: () =>
      apiFetch<Page<Pipeline>>("/api/crm/pipelines/", { query: { limit: 100 } }),
    select: (page) => page.results,
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
        // Follow-ups are tasks on the CRM project's board.
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
  relationship: Relationship | "";
  owner: number | null;
  headline: string;
  company: string | null;
  emails: string[];
  phone: string;
  whatsapp: string;
  linkedin_url: string;
  website: string;
  wiki_slug: string;
  /** Project ids or prefixes; replaces the contact's set. */
  projects: (string | number)[];
  /** Added to the contact's projects, keeping the rest. */
  add_projects: (string | number)[];
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
      apiFetch<ContactDetail>(`/api/crm/contacts/${id}/`, {
        method: "PATCH",
        body,
      }),
    { meetings: true },
  );
}

export function useLogTouchpoint() {
  return useCrmWrite(
    (body: {
      kind: TouchpointKind;
      summary: string;
      entities: number[];
      occurred_at?: string;
      direction?: string;
      deal?: string | null;
      follow_up?: { title: string; due?: string | null } | null;
    }) =>
      apiFetch<Touchpoint>("/api/crm/touchpoints/", {
        method: "POST",
        body: { source: "manual", tz: browserTz(), ...body },
      }),
    { tasks: true },
  );
}

export function useUpdateTouchpoint() {
  return useCrmWrite(
    ({ id, ...body }: { id: number; summary?: string; kind?: TouchpointKind; occurred_at?: string }) =>
      apiFetch<Touchpoint>(`/api/crm/touchpoints/${id}/`, { method: "PATCH", body }),
  );
}

export function useDeleteTouchpoint() {
  return useCrmWrite((id: number) =>
    apiFetch(`/api/crm/touchpoints/${id}/`, { method: "DELETE" }),
  );
}

export function useCreateFollowUp() {
  return useCrmWrite(
    (body: {
      entity: number;
      title: string;
      due?: string | null;
      deal?: string | null;
      assignee?: number | null;
    }) =>
      apiFetch<FollowUp>("/api/crm/follow-ups/", {
        method: "POST",
        body: { tz: browserTz(), ...body },
      }),
    { tasks: true },
  );
}

export function useFollowUpAction() {
  return useCrmWrite(
    ({
      id,
      action,
      due,
    }: {
      id: number;
      action: "complete" | "reopen" | "reschedule";
      due?: string | null;
    }) =>
      apiFetch<FollowUp>(`/api/crm/follow-ups/${id}/${action}/`, {
        method: "POST",
        body: action === "reschedule" ? { due, tz: browserTz() } : {},
      }),
    { tasks: true },
  );
}

export type DealWrite = Partial<{
  title: string;
  pipeline: number;
  stage: number;
  company: number | null;
  contacts: number[];
  owner: number | null;
  value: string | null;
  currency: string;
  project: number | null;
  expected_close: string | null;
  notes: string;
  lost_reason: string;
}>;

export function useCreateDeal() {
  return useCrmWrite((body: DealWrite) =>
    apiFetch<DealDetail>("/api/crm/deals/", { method: "POST", body }),
  );
}

export function useUpdateDeal() {
  return useCrmWrite(({ key, ...body }: DealWrite & { key: string }) =>
    apiFetch<DealDetail>(`/api/crm/deals/${key}/`, { method: "PATCH", body }),
  );
}

export function useDeleteDeal() {
  return useCrmWrite((key: string) =>
    apiFetch(`/api/crm/deals/${key}/`, { method: "DELETE" }),
  );
}

/** Optimistic: the card jumps columns immediately, then the server's
 *  position wins on refetch. Rolls back on error. */
export function useMoveDeal(pipeline: number | null, project = "") {
  const qc = useQueryClient();
  const key = dealsKey(pipeline, project);
  return useMutation({
    mutationFn: ({ dealKey, stage, index }: { dealKey: string; stage: number; index?: number }) =>
      apiFetch<DealDetail>(`/api/crm/deals/${dealKey}/move/`, {
        method: "POST",
        body: { stage, index },
      }),
    onMutate: async ({ dealKey, stage }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Page<Deal>>(key);
      if (prev) {
        qc.setQueryData<Page<Deal>>(key, {
          ...prev,
          results: prev.results.map((d) =>
            d.key === dealKey ? { ...d, stage: { ...d.stage, id: stage } } : d,
          ),
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

export function useCreatePipeline() {
  return useCrmWrite((body: { name: string }) =>
    apiFetch<Pipeline>("/api/crm/pipelines/", { method: "POST", body }),
  );
}

export function useUpdatePipeline() {
  return useCrmWrite(
    ({
      id,
      name,
      stages,
    }: {
      id: number;
      name?: string;
      stages?: { id?: number; name: string; kind: StageKind }[];
    }) => {
      const writes: Promise<unknown>[] = [];
      if (name !== undefined)
        writes.push(
          apiFetch(`/api/crm/pipelines/${id}/`, { method: "PATCH", body: { name } }),
        );
      if (stages)
        writes.push(
          apiFetch(`/api/crm/pipelines/${id}/stages/`, {
            method: "PUT",
            body: { stages },
          }),
        );
      return Promise.all(writes);
    },
  );
}

export function useDeletePipeline() {
  return useCrmWrite((id: number) =>
    apiFetch(`/api/crm/pipelines/${id}/`, { method: "DELETE" }),
  );
}

export type SitePreview = { url: string; domain: string; name: string; description: string };

/** Name + one-line description read off a company's website (stores nothing). */
export function useSitePreview() {
  return useMutation({
    mutationFn: (url: string) =>
      apiFetch<SitePreview>("/api/crm/site-preview/", { query: { url } }),
  });
}
