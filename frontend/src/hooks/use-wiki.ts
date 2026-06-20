"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { wikiDocKey, wikiTreeKey } from "@/lib/query-keys";
import type { WikiDoc, WikiDocDetail, WikiValue } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────

/** The whole page tree as a flat list (no pagination — the client nests it). */
export function useWikiTreeQuery() {
  return useQuery({
    queryKey: wikiTreeKey(),
    queryFn: () => apiFetch<WikiDoc[]>("/api/wiki-docs/"),
  });
}

export function useWikiDocQuery(key: string | null) {
  return useQuery({
    queryKey: key ? wikiDocKey(key) : ["wiki", "doc", "__none__"],
    queryFn: () => apiFetch<WikiDocDetail>(`/api/wiki-docs/${key}/`),
    enabled: !!key,
    // The live body is owned by the collab socket; the snapshot is only for
    // first paint. Don't refetch it out from under an open editor.
    staleTime: 5 * 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────

function invalidateWiki(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["wiki"] });
}

export type CreateDocPayload = {
  title?: string;
  parent_id?: number | null;
  project_id?: number | null;
};

export function useCreateDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDocPayload) =>
      apiFetch<WikiDocDetail>("/api/wiki-docs/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => invalidateWiki(qc),
  });
}

export type UpdateDocPayload = {
  key: string;
  title?: string;
  parent_id?: number | null;
  project_id?: number | null;
};

export function useUpdateDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...payload }: UpdateDocPayload) =>
      apiFetch<WikiDoc>(`/api/wiki-docs/${key}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: (_doc, variables) => {
      invalidateWiki(qc);
      qc.invalidateQueries({ queryKey: wikiDocKey(variables.key) });
    },
  });
}

export type MoveDocPayload = {
  key: string;
  parent_id?: number | null;
  before_id?: number | null;
  after_id?: number | null;
  position?: number;
};

export function useMoveDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...payload }: MoveDocPayload) =>
      apiFetch<WikiDoc>(`/api/wiki-docs/${key}/move/`, {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => invalidateWiki(qc),
  });
}

export function useDeleteDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<void>(`/api/wiki-docs/${key}/`, { method: "DELETE" }),
    onSuccess: () => invalidateWiki(qc),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Body snapshot push (debounced by the editor). The CRDT is the source of
// truth; this just keeps content/plain_text fresh for read / search / MCP.
// ─────────────────────────────────────────────────────────────────────────

export function saveWikiSnapshot(key: string, content: WikiValue): Promise<void> {
  return apiFetch<void>(`/api/wiki-docs/${key}/snapshot/`, {
    method: "POST",
    body: { content },
  });
}
