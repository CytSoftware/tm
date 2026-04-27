"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { projectKey, projectsKey } from "@/lib/query-keys";
import type { Column } from "@/lib/types";

function invalidateProject(qc: ReturnType<typeof useQueryClient>, projectId: number) {
  qc.invalidateQueries({ queryKey: projectKey(projectId) });
  qc.invalidateQueries({ queryKey: projectsKey() });
}

export function useCreateColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { project: number; name: string; is_done?: boolean }) =>
      apiFetch<Column>("/api/columns/", { method: "POST", body: payload }),
    onSuccess: (col) => invalidateProject(qc, col.project),
  });
}

export function useUpdateColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: number;
      name?: string;
      is_done?: boolean;
    }) =>
      apiFetch<Column>(`/api/columns/${id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: (col) => invalidateProject(qc, col.project),
  });
}

export function useDeleteColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: number;
      projectId: number;
      moveTasksTo?: number;
    }) => {
      const qs =
        vars.moveTasksTo != null ? `?move_tasks_to=${vars.moveTasksTo}` : "";
      return apiFetch<void>(`/api/columns/${vars.id}/${qs}`, {
        method: "DELETE",
      });
    },
    onSuccess: (_v, vars) => {
      invalidateProject(qc, vars.projectId);
      qc.invalidateQueries({ queryKey: ["tasks-infinite"] });
    },
  });
}

export function useReorderColumns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { project: number; ordered_ids: number[] }) =>
      apiFetch<Column[]>("/api/columns/reorder/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: (_cols, vars) => invalidateProject(qc, vars.project),
  });
}
