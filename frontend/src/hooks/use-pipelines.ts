"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import {
  pipelineKey,
  pipelineEventsKey,
  pipelineListKey,
  pipelineStagesKey,
} from "@/lib/query-keys";
import type {
  Pipeline,
  PipelineDetail,
  PipelineEventEntry,
  PipelineListResponse,
  Stage,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────
// Stages — small read-only set, fetched once per session.
// ─────────────────────────────────────────────────────────────────────────

export function usePipelineStagesQuery() {
  return useQuery({
    queryKey: pipelineStagesKey(),
    queryFn: () => apiFetch<Stage[]>("/api/pipeline-stages/"),
    staleTime: 5 * 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// List with simple filters. v1 uses a flat list (no infinite pagination —
// pipelines are low-volume by nature).
// ─────────────────────────────────────────────────────────────────────────

export type PipelineFilters = {
  search: string;
  ownerIds: number[];
};

export const EMPTY_PIPELINE_FILTERS: PipelineFilters = {
  search: "",
  ownerIds: [],
};

function pipelineFiltersCacheKey(filters: PipelineFilters): string {
  return JSON.stringify({
    search: filters.search.trim(),
    ownerIds: filters.ownerIds,
  });
}

function buildPipelineQS(filters: PipelineFilters): string {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  for (const id of filters.ownerIds) params.append("owner", String(id));
  // Bumped page size so the kanban gets every pipeline in one request — these
  // are low-volume by nature; we'll add pagination only if the count grows.
  params.set("limit", "500");
  return params.toString();
}

export function usePipelinesQuery(filters: PipelineFilters) {
  const filtersKey = pipelineFiltersCacheKey(filters);
  return useQuery({
    queryKey: pipelineListKey(filtersKey),
    queryFn: () => {
      const qs = buildPipelineQS(filters);
      return apiFetch<PipelineListResponse>(`/api/pipelines/?${qs}`);
    },
  });
}

export function usePipelineQuery(key: string | null) {
  return useQuery({
    queryKey: key ? pipelineKey(key) : ["pipeline", "__none__"],
    queryFn: () => apiFetch<PipelineDetail>(`/api/pipelines/${key}/`),
    enabled: !!key,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────

function invalidatePipelines(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["pipelines"] });
}

export type CreatePipelinePayload = {
  title: string;
  description?: string;
  counterparty?: string;
  stage_id?: number;
  owner_id?: number | null;
};

export function useCreatePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePipelinePayload) =>
      apiFetch<Pipeline>("/api/pipelines/", { method: "POST", body: payload }),
    onSuccess: () => invalidatePipelines(qc),
  });
}

export type UpdatePipelinePayload = Partial<CreatePipelinePayload> & {
  key: string;
};

export function useUpdatePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...payload }: UpdatePipelinePayload) =>
      apiFetch<Pipeline>(`/api/pipelines/${key}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: (_pipeline, variables) => {
      invalidatePipelines(qc);
      qc.invalidateQueries({ queryKey: pipelineKey(variables.key) });
    },
  });
}

export function useDeletePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<void>(`/api/pipelines/${key}/`, { method: "DELETE" }),
    onSuccess: () => invalidatePipelines(qc),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Move (drag-drop). Optimistic — same shape as useMoveTask.
// ─────────────────────────────────────────────────────────────────────────

type MovePipelinePayload = {
  key: string;
  stage_id: number;
  before_id?: number | null;
  after_id?: number | null;
  position?: number;
  optimistic?: {
    destStage: Stage;
    estimatedPosition: number;
  };
};

export function useMovePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      optimistic: _optimistic,
      ...payload
    }: MovePipelinePayload) =>
      apiFetch<Pipeline>(`/api/pipelines/${key}/move/`, {
        method: "POST",
        body: payload,
      }),
    onMutate: async ({ key, optimistic }) => {
      await qc.cancelQueries({ queryKey: ["pipelines"] });
      const snapshots = qc.getQueriesData<PipelineListResponse>({
        queryKey: ["pipelines"],
      });
      if (!optimistic) return { snapshots };

      for (const [queryKey, data] of snapshots) {
        if (!data) continue;
        const moving = data.results.find((p) => p.key === key);
        if (!moving) continue;
        const next: Pipeline = {
          ...moving,
          stage: optimistic.destStage,
          position: optimistic.estimatedPosition,
        };
        const without = data.results.filter((p) => p.key !== key);
        const newResults = [...without, next].sort((a, b) => {
          if (a.stage.order !== b.stage.order)
            return a.stage.order - b.stage.order;
          if (a.position !== b.position) return a.position - b.position;
          return a.id - b.id;
        });
        qc.setQueryData<PipelineListResponse>(queryKey, {
          ...data,
          results: newResults,
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      for (const [queryKey, data] of ctx.snapshots) {
        qc.setQueryData(queryKey, data);
      }
    },
    onSuccess: () => {
      invalidatePipelines(qc);
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Events (timeline)
// ─────────────────────────────────────────────────────────────────────────

export function usePipelineEventsQuery(key: string | null) {
  return useQuery({
    queryKey: key ? pipelineEventsKey(key) : ["pipeline-events", "__none__"],
    queryFn: () =>
      apiFetch<PipelineEventEntry[]>(`/api/pipelines/${key}/events/`),
    enabled: !!key,
  });
}

export type LogEventPayload = {
  key: string;
  body: string;
};

export function useLogPipelineEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: LogEventPayload) =>
      apiFetch<PipelineEventEntry>(`/api/pipelines/${key}/events/`, {
        method: "POST",
        body: { body },
      }),
    onSuccess: (_event, variables) => {
      qc.invalidateQueries({ queryKey: pipelineEventsKey(variables.key) });
      qc.invalidateQueries({ queryKey: pipelineKey(variables.key) });
      invalidatePipelines(qc);
    },
  });
}
