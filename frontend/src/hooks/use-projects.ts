"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { projectsKey } from "@/lib/query-keys";
import type { Project, ProjectListResponse } from "@/lib/types";

type ProjectsQueryArgs = {
  includeArchived?: boolean;
};

/**
 * Single source of truth for the project list query. Previously three
 * components fetched /api/projects/ inline; they all go through this now
 * so the sidebar gets the cache for free and invalidations fan out.
 */
export function useProjectsQuery({
  includeArchived = true,
}: ProjectsQueryArgs = {}) {
  return useQuery({
    queryKey: projectsKey(),
    queryFn: () => apiFetch<ProjectListResponse>("/api/projects/"),
    select: includeArchived
      ? undefined
      : (data) => ({
          ...data,
          results: data.results.filter((p) => !p.archived),
        }),
  });
}

export function useProjectQuery(projectId: number | null) {
  return useQuery({
    queryKey: ["project", projectId ?? 0],
    queryFn: () => apiFetch<Project>(`/api/projects/${projectId}/`),
    enabled: projectId !== null,
  });
}

type CreateProjectPayload = {
  name: string;
  prefix: string;
  description?: string;
  color?: string;
  icon?: string;
};

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProjectPayload) =>
      apiFetch<Project>("/api/projects/", { method: "POST", body: payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });
}

type UpdateProjectPayload = Partial<
  Pick<Project, "name" | "description" | "color" | "icon" | "archived">
>;

export function useUpdateProject(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateProjectPayload) =>
      apiFetch<Project>(`/api/projects/${projectId}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: (project) => {
      qc.setQueryData(["project", projectId], project);
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/projects/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });
}

/**
 * Optimistic star — flips is_starred in the cache immediately so the sidebar
 * re-orders without a round-trip. Rolls back on error.
 */
export function useStarProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Project>(`/api/projects/${id}/star/`, { method: "POST" }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: projectsKey() });
      const previous = qc.getQueryData<ProjectListResponse>(projectsKey());
      if (previous) {
        qc.setQueryData<ProjectListResponse>(projectsKey(), {
          ...previous,
          results: previous.results.map((p) =>
            p.id === id ? { ...p, is_starred: true } : p,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(projectsKey(), ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });
}

export function useUnstarProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Project>(`/api/projects/${id}/unstar/`, { method: "POST" }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: projectsKey() });
      const previous = qc.getQueryData<ProjectListResponse>(projectsKey());
      if (previous) {
        qc.setQueryData<ProjectListResponse>(projectsKey(), {
          ...previous,
          results: previous.results.map((p) =>
            p.id === id ? { ...p, is_starred: false } : p,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(projectsKey(), ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });
}
