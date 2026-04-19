"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import {
  projectKey,
  taskListKey,
  viewsKey,
} from "@/lib/query-keys";
import type {
  Task,
  TaskListResponse,
  Priority,
} from "@/lib/types";

type TasksQueryArgs = {
  projectId: number | null;
  viewId: number | null;
};

export function useTasksQuery({ projectId, viewId }: TasksQueryArgs) {
  return useQuery({
    queryKey: taskListKey(projectId ?? 0, viewId),
    queryFn: () =>
      apiFetch<TaskListResponse>("/api/tasks/", {
        query: {
          project: projectId ?? undefined,
          view: viewId ?? undefined,
          limit: 500,
        },
      }),
  });
}

type CreateTaskPayload = {
  project_id: number;
  column_id: number;
  title: string;
  description?: string;
  assignee_id?: number | null;
  priority?: Priority;
  label_ids?: number[];
  story_points?: number | null;
};

/** Invalidate all task-related queries so the board reflects changes immediately. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["tasks"] });
  qc.invalidateQueries({ queryKey: ["projects"] });
}

export function useCreateTask(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTaskPayload) =>
      apiFetch<Task>("/api/tasks/", { method: "POST", body: payload }),
    onSuccess: () => invalidateAll(qc),
  });
}

type UpdateTaskPayload = Partial<CreateTaskPayload> & { key: string };

export function useUpdateTask(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...payload }: UpdateTaskPayload) =>
      apiFetch<Task>(`/api/tasks/${key}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteTask(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<void>(`/api/tasks/${key}/`, { method: "DELETE" }),
    onSuccess: () => invalidateAll(qc),
  });
}

type MovePayload = {
  key: string;
  column_id: number;
  before_id?: number | null;
  after_id?: number | null;
  position?: number;
};

export function useMoveTask(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...payload }: MovePayload) =>
      apiFetch<Task>(`/api/tasks/${key}/move/`, {
        method: "POST",
        body: payload,
      }),
    // Optimistic update for the drag interaction.
    //
    // Deliberately synchronous (no async / await): hello-pangea/dnd starts
    // its drop animation the same tick `onDragEnd` returns, and it computes
    // the drop home from the Draggable at the destination index. If this
    // handler yields to microtasks before calling `setQueryData`, React
    // renders one frame with stale data — rbd animates to the old home,
    // then the card snaps to the new one once the cache settles. Running
    // sync lets the cache update land in the same flush as the drop event
    // so rbd sees the new order immediately.
    onMutate: ({ key, column_id, before_id, after_id }) => {
      qc.cancelQueries({ queryKey: taskListKey(projectId) });
      const snapshots = qc.getQueriesData<TaskListResponse>({
        queryKey: taskListKey(projectId),
      });
      for (const [queryKey, data] of snapshots) {
        if (!data) continue;
        const tasks = [...data.results];
        const idx = tasks.findIndex((t) => t.key === key);
        if (idx === -1) continue;
        const moving = tasks.splice(idx, 1)[0];

        // Find a new position relative to neighbors, if provided.
        let newPosition = moving.position;
        if (before_id != null) {
          const before = tasks.find((t) => t.id === before_id);
          if (before) newPosition = before.position - 0.5;
        } else if (after_id != null) {
          const after = tasks.find((t) => t.id === after_id);
          if (after) newPosition = after.position + 0.5;
        }

        const columnObj = tasks.find(
          (t) => t.column?.id === column_id,
        )?.column;
        const fallbackColumn =
          moving.column ??
          (columnObj ?? null);
        const optimistic: Task = {
          ...moving,
          column: columnObj ?? (fallbackColumn ? { ...fallbackColumn, id: column_id } : null),
          position: newPosition,
        };
        tasks.push(optimistic);
        tasks.sort((a, b) => {
          const aColId = a.column?.id ?? -1;
          const bColId = b.column?.id ?? -1;
          if (aColId !== bColId) return aColId - bColId;
          return a.position - b.position;
        });
        qc.setQueryData<TaskListResponse>(queryKey, {
          ...data,
          results: tasks,
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
    onSettled: () => {
      qc.invalidateQueries({ queryKey: taskListKey(projectId) });
      qc.invalidateQueries({ queryKey: viewsKey() });
    },
  });
}
