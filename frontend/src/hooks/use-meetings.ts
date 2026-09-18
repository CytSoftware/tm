"use client";

/**
 * Meetings data hooks.
 *
 * Meetings are *written* by the recording pipeline; people only curate them
 * (category, project, people, tags, action items). So the mutations here are
 * the curation ones — there is no "create meeting".
 *
 * Every mutation invalidates the whole ["meetings"] namespace: a single edit
 * (say, moving a meeting to another company) changes the list grouping, the
 * graph, the facets and other meetings' "related" panels all at once.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import {
  meetingEntitiesKey,
  meetingKey,
  meetingRelatedKey,
  meetingsFacetsKey,
  meetingsGraphKey,
  meetingsListKey,
} from "@/lib/query-keys";

export type MeetingCategory =
  "client" | "internal" | "pitch_feedback" | "sales" | "interview" | "other";

export type EntityKind = "person" | "company";

export type MeetingEntityRef = {
  id: number;
  kind: EntityKind;
  name: string;
  slug: string;
  role: "attendee" | "mentioned";
  company_id: number | null;
};

export type MeetingProjectRef = {
  id: number;
  prefix: string;
  name: string;
  color: string;
};

export type ActionItem = {
  id: string;
  text: string;
  owner: string;
  done: boolean;
  task_key: string | null;
};

export type MeetingSummary = {
  key: string;
  stem: string;
  title: string;
  started_at: string;
  duration_seconds: number | null;
  language: string;
  speaker_count: number | null;
  category: MeetingCategory;
  summary: string;
  gshr_url: string;
  project: MeetingProjectRef | null;
  entities: MeetingEntityRef[];
  tags: string[];
  action_item_count: number;
  open_action_item_count: number;
  snippet: string;
};

export type MeetingDetail = MeetingSummary & {
  brief_md: string;
  transcript_md: string;
  action_items: ActionItem[];
  linked_tasks: {
    key: string;
    title: string;
    column: string | null;
    is_done: boolean;
    project: string | null;
  }[];
};

export type RelatedMeeting = {
  key: string;
  title: string;
  started_at: string;
  category: MeetingCategory;
  score: number;
  link_kind: "follow_up" | "related" | null;
  reasons: string[];
};

export type GraphNode =
  | {
      id: string;
      type: "meeting";
      key: string;
      label: string;
      category: MeetingCategory;
      started_at: string;
    }
  | {
      id: string;
      type: EntityKind;
      entity_id: number;
      slug: string;
      label: string;
      meeting_count: number;
    }
  | {
      id: string;
      type: "project";
      project_id: number;
      label: string;
      color: string;
    };

export type GraphEdge = {
  source: string;
  target: string;
  kind:
    "attendee" | "mentioned" | "project" | "works_at" | "follow_up" | "related";
};

export type MeetingGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type MeetingFacets = {
  total: number;
  categories: { value: MeetingCategory; label: string; count: number }[];
  tags: { name: string; count: number }[];
  projects: {
    project_id: number;
    project__prefix: string;
    project__name: string;
    count: number;
  }[];
};

export type MeetingEntity = {
  id: number;
  kind: EntityKind;
  name: string;
  slug: string;
  aliases: string[];
  wiki_slug: string;
  company: number | null;
  company_name?: string;
  meeting_count: number;
};

/** The filter dict the backend's `meetings/query.py` understands. */
export type MeetingFilters = {
  search?: string;
  category?: string;
  project?: string;
  entity?: string;
  tag?: string;
  date_from?: string;
  date_to?: string;
};

type Page<T> = { count: number; results: T[] };

const filtersKey = (f: MeetingFilters) =>
  JSON.stringify(
    Object.entries(f)
      .filter(([, v]) => v)
      .sort(),
  );

export function useMeetings(filters: MeetingFilters, enabled = true) {
  return useQuery({
    queryKey: meetingsListKey(filtersKey(filters)),
    queryFn: () =>
      apiFetch<Page<MeetingSummary>>("/api/meetings/", {
        query: { ...filters, limit: 1000 },
      }),
    enabled,
    select: (page) => page.results,
    // Keep the old rows on screen while a new search term loads.
    placeholderData: keepPreviousData,
  });
}

export function useMeetingGraph(
  filters: MeetingFilters,
  opts: { mentioned: boolean; projects: boolean },
  enabled = true,
) {
  return useQuery({
    queryKey: meetingsGraphKey(
      `${filtersKey(filters)}|${opts.mentioned}|${opts.projects}`,
    ),
    queryFn: () =>
      apiFetch<MeetingGraph>("/api/meetings/graph/", {
        query: {
          ...filters,
          mentioned: opts.mentioned,
          projects: opts.projects,
        },
      }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useMeetingFacets() {
  return useQuery({
    queryKey: meetingsFacetsKey(),
    queryFn: () => apiFetch<MeetingFacets>("/api/meetings/facets/"),
  });
}

export function useMeetingEntities() {
  return useQuery({
    queryKey: meetingEntitiesKey(),
    queryFn: () =>
      apiFetch<Page<MeetingEntity>>("/api/meeting-entities/", {
        query: { limit: 1000 },
      }),
    select: (page) => page.results,
  });
}

export function useMeeting(key: string | null) {
  return useQuery({
    queryKey: key ? meetingKey(key) : ["meetings", "detail", "__none__"],
    queryFn: () => apiFetch<MeetingDetail>(`/api/meetings/${key}/`),
    enabled: !!key,
  });
}

export function useRelatedMeetings(key: string | null) {
  return useQuery({
    queryKey: key
      ? meetingRelatedKey(key)
      : ["meetings", "related", "__none__"],
    queryFn: () => apiFetch<RelatedMeeting[]>(`/api/meetings/${key}/related/`),
    enabled: !!key,
  });
}

export type MeetingPatch = {
  title?: string;
  category?: MeetingCategory;
  project?: string | null;
  tags?: string[];
  entities?: {
    kind: EntityKind;
    name: string;
    role: "attendee" | "mentioned";
  }[];
};

/** All curation writes share one shape: call the API, refresh everything. */
function useMeetingWrite<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meetings"] }),
  });
}

export function useUpdateMeeting(key: string) {
  return useMeetingWrite((patch: MeetingPatch) =>
    apiFetch(`/api/meetings/${key}/`, { method: "PATCH", body: patch }),
  );
}

export function useToggleActionItem(key: string) {
  return useMeetingWrite(({ id, done }: { id: string; done: boolean }) =>
    apiFetch(`/api/meetings/${key}/action-items/${encodeURIComponent(id)}/`, {
      method: "PATCH",
      body: { done },
    }),
  );
}

export function useCreateTaskFromActionItem(key: string) {
  return useMeetingWrite(({ id, project }: { id: string; project?: string }) =>
    apiFetch(
      `/api/meetings/${key}/action-items/${encodeURIComponent(id)}/create-task/`,
      { method: "POST", body: project ? { project } : {} },
    ),
  );
}

export function useLinkMeetings(key: string) {
  return useMeetingWrite(
    ({ to, kind, remove }: { to: string; kind?: string; remove?: boolean }) =>
      apiFetch(`/api/meetings/${key}/links/`, {
        method: remove ? "DELETE" : "POST",
        body: { to, kind: kind ?? "follow_up" },
      }),
  );
}
