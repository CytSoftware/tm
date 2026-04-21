/** Centralized TanStack Query keys so invalidation is consistent. */

export const meKey = () => ["me"] as const;

export const projectsKey = () => ["projects"] as const;
export const projectKey = (projectId: number) => ["project", projectId] as const;

export const taskListKey = (projectId: number, viewId?: number | null) =>
  ["tasks", projectId, viewId ?? null] as const;

/** Key for the infinite, server-paginated task query used by the board/list.
 *  Filters are stringified so object-identity doesn't invalidate the cache on
 *  every re-render of the board page. */
export const taskInfiniteKey = (args: {
  projectId: number | null;
  columnId: number | null;
  columnName: string | null;
  filtersKey: string;
}) =>
  [
    "tasks-infinite",
    args.projectId,
    args.columnId,
    args.columnName,
    args.filtersKey,
  ] as const;

export const taskKey = (key: string) => ["task", key] as const;

export const viewsKey = () => ["views"] as const;

export const usersKey = () => ["users"] as const;

export const recurringKey = (projectId: number) =>
  ["recurring", projectId] as const;
