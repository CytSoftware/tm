"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import {
  taskInfiniteKey,
  viewsKey,
} from "@/lib/query-keys";
import type {
  BoardFilters,
  Task,
  TaskListResponse,
  Priority,
} from "@/lib/types";

type TasksInfiniteArgs = {
  projectId: number | null;
  /** When set, scope the query to a single column by id (single-project kanban). */
  columnId?: number | null;
  /** When set, scope the query to a column by name (all-projects virtual columns). */
  columnName?: string | null;
  /** Board filter + sort state. The fields here are translated into
   *  saved-view-shaped query-string params the backend understands. */
  filters: BoardFilters;
  /** Page size. Kanban columns use a smaller value than the list view. */
  limit?: number;
  enabled?: boolean;
};

/**
 * Build the full set of query params the tasks endpoint expects for a given
 * board-filter state. Multi-valued params (``priority``, ``assignee``,
 * ``label``) are emitted as repeated keys so ``apply_task_filters`` on the
 * server reads them via ``params.getlist(...)``.
 */
function buildTaskQueryString(
  args: TasksInfiniteArgs,
  offset: number,
): string {
  const params = new URLSearchParams();
  const { filters, columnId, columnName, projectId, limit } = args;

  if (projectId != null) params.set("project", String(projectId));
  else if (filters.project != null)
    params.set("project", String(filters.project));

  if (columnId != null) params.set("column", String(columnId));
  else if (columnName) params.set("column", columnName);
  else if (filters.columnName) params.set("column", filters.columnName);

  for (const p of filters.priorities) params.append("priority", p);

  if (filters.includeUnassigned) params.append("assignee", "none");
  for (const id of filters.assigneeIds) params.append("assignee", String(id));

  for (const id of filters.labelIds) params.append("label", String(id));

  if (filters.search.trim()) params.set("search", filters.search.trim());

  const primarySort = filters.sort[0];
  if (primarySort) {
    params.set("sort_field", primarySort.field);
    params.set("sort_dir", primarySort.dir);
  }

  params.set("offset", String(offset));
  params.set("limit", String(limit ?? 50));

  return params.toString();
}

/**
 * Stable cache key for ``BoardFilters``. JSON-stringify is enough because the
 * filter fields are primitives / arrays of primitives and we always build a
 * fresh object — there's no circular reference to worry about.
 */
export function filtersCacheKey(
  filters: BoardFilters,
  projectId: number | null,
): string {
  return JSON.stringify({
    projectId,
    priorities: filters.priorities,
    assigneeIds: filters.assigneeIds,
    includeUnassigned: filters.includeUnassigned,
    labelIds: filters.labelIds,
    columnName: filters.columnName,
    search: filters.search.trim(),
    sort: filters.sort,
  });
}

export function useTasksInfinite(args: TasksInfiniteArgs) {
  const { projectId, columnId, columnName, filters, enabled } = args;
  const filtersKey = filtersCacheKey(filters, projectId);

  return useInfiniteQuery<TaskListResponse>({
    queryKey: taskInfiniteKey({
      projectId,
      columnId: columnId ?? null,
      columnName: columnName ?? null,
      filtersKey,
    }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const qs = buildTaskQueryString(args, pageParam as number);
      return apiFetch<TaskListResponse>(`/api/tasks/?${qs}`);
    },
    getNextPageParam: (last, pages) => {
      if (!last.next) return undefined;
      const loaded = pages.reduce((n, p) => n + p.results.length, 0);
      return loaded;
    },
    enabled: enabled !== false,
  });
}

/** Flatten a TanStack infinite-query result into a plain Task list. */
export function flattenInfinite(
  data: InfiniteData<TaskListResponse> | undefined,
): Task[] {
  if (!data) return [];
  const out: Task[] = [];
  for (const page of data.pages) out.push(...page.results);
  return out;
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

/** Invalidate every task-scoped query so the board + list refetch. */
function invalidateAll(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["tasks"] });
  qc.invalidateQueries({ queryKey: ["tasks-infinite"] });
  qc.invalidateQueries({ queryKey: ["projects"] });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTaskPayload) =>
      apiFetch<Task>("/api/tasks/", { method: "POST", body: payload }),
    onSuccess: () => invalidateAll(qc),
  });
}

type UpdateTaskPayload = Partial<CreateTaskPayload> & { key: string };

export function useUpdateTask() {
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

export function useDeleteTask() {
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
  /** Client-only hint for the optimistic cache update. Stripped from the
   *  request body before the POST hits the server — the server would reject
   *  the extra field anyway. Skipping it (e.g. when the drop metadata is
   *  unresolved) degrades to the old "remove from source, wait for server,
   *  re-insert" behaviour. */
  optimistic?: {
    destColumn: import("@/lib/types").Column;
    estimatedPosition: number;
  };
};

type InfiniteSnapshot = Array<
  [readonly unknown[], InfiniteData<TaskListResponse> | undefined]
>;

/** Remove a task by id from every ``tasks-infinite`` cache. */
function removeTaskFromInfiniteCaches(qc: QueryClient, taskId: number) {
  const caches = qc.getQueriesData<InfiniteData<TaskListResponse>>({
    queryKey: ["tasks-infinite"],
  }) as InfiniteSnapshot;
  for (const [queryKey, data] of caches) {
    if (!data) continue;
    let changed = false;
    const newPages = data.pages.map((page) => {
      const filtered = page.results.filter((t) => t.id !== taskId);
      if (filtered.length !== page.results.length) {
        changed = true;
        return { ...page, results: filtered };
      }
      return page;
    });
    if (changed) {
      qc.setQueryData<InfiniteData<TaskListResponse>>(queryKey, {
        ...data,
        pages: newPages,
      });
    }
  }
}

/** Insert a task into every infinite cache whose column scope matches the
 *  task's column. Position-sorted slot; the cache is already in position
 *  order so we just find the first entry whose position is greater. */
function insertTaskIntoMatchingCaches(qc: QueryClient, task: Task) {
  if (!task.column) return;
  const caches = qc.getQueriesData<InfiniteData<TaskListResponse>>({
    queryKey: ["tasks-infinite"],
  }) as InfiniteSnapshot;

  for (const [queryKey, data] of caches) {
    if (!data) continue;
    const keyColumnId = queryKey[2] as number | null;
    const keyColumnName = queryKey[3] as string | null;

    let matches: boolean;
    if (keyColumnId != null) {
      matches = keyColumnId === task.column.id;
    } else if (keyColumnName != null) {
      matches = keyColumnName.toLowerCase() === task.column.name.toLowerCase();
    } else {
      // Unscoped list-view cache — always keep in sync.
      matches = true;
    }
    if (!matches) continue;

    // Flatten, insert at the first slot whose position is greater than
    // ours (or append), then re-chunk back into pages preserving their
    // sizes (the last page absorbs any added item). Works for virtual
    // all-projects caches too because the backend now resolves move
    // ``before_id``/``after_id`` globally — so the server-assigned
    // position is numerically consistent with the visible slot the user
    // dropped into, regardless of project.
    const pageSizes = data.pages.map((p) => p.results.length);
    const flat = data.pages.flatMap((p) => p.results);
    let insertIdx = flat.findIndex((t) => t.position > task.position);
    if (insertIdx === -1) insertIdx = flat.length;
    const reordered = [
      ...flat.slice(0, insertIdx),
      task,
      ...flat.slice(insertIdx),
    ];

    const newPages = data.pages.map((page, pageIdx) => {
      const start = pageSizes.slice(0, pageIdx).reduce((a, b) => a + b, 0);
      const end =
        pageIdx === data.pages.length - 1
          ? reordered.length
          : start + pageSizes[pageIdx];
      return { ...page, results: reordered.slice(start, end) };
    });

    qc.setQueryData<InfiniteData<TaskListResponse>>(queryKey, {
      ...data,
      pages: newPages,
    });
  }
}

export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, optimistic: _optimistic, ...payload }: MovePayload) =>
      apiFetch<Task>(`/api/tasks/${key}/move/`, {
        method: "POST",
        body: payload,
      }),
    // Drag-and-drop mutation lifecycle:
    //
    //   onMutate  → snapshot caches, remove the source card everywhere,
    //               and re-insert a client-built copy at the destination
    //               using an estimated position. The card is visible in
    //               its new slot on the next frame — no network wait.
    //   onSuccess → replace the optimistic copy with the server-authored
    //               task at its authoritative position. Usually a no-op
    //               visually because the estimate matched.
    //   onError   → restore snapshots.
    //   onSettled → no refetch; manual cache edits are authoritative.
    //               (WebSocket task.moved events from OTHER sessions
    //               still arrive via ws.ts and invalidate appropriately.)
    onMutate: ({ key, optimistic }) => {
      qc.cancelQueries({ queryKey: ["tasks-infinite"] });
      const snapshots = qc.getQueriesData<InfiniteData<TaskListResponse>>({
        queryKey: ["tasks-infinite"],
      }) as InfiniteSnapshot;

      // Find the moving task by its key so we can grab its id.
      let moving: Task | undefined;
      for (const [, data] of snapshots) {
        if (!data) continue;
        for (const page of data.pages) {
          const hit = page.results.find((t) => t.key === key);
          if (hit) {
            moving = hit;
            break;
          }
        }
        if (moving) break;
      }
      if (moving) {
        removeTaskFromInfiniteCaches(qc, moving.id);
        if (optimistic) {
          insertTaskIntoMatchingCaches(qc, {
            ...moving,
            column: optimistic.destColumn,
            position: optimistic.estimatedPosition,
          });
        }
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      for (const [queryKey, data] of ctx.snapshots) {
        qc.setQueryData(queryKey, data);
      }
    },
    onSuccess: (serverTask) => {
      // Defensive: remove any lingering copy (e.g. from a previous cache
      // state that didn't see onMutate), then insert fresh at the
      // server-dictated position.
      removeTaskFromInfiniteCaches(qc, serverTask.id);
      insertTaskIntoMatchingCaches(qc, serverTask);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: viewsKey() });
    },
  });
}
