/** Centralized TanStack Query keys so invalidation is consistent. */

export const meKey = () => ["me"] as const;

export const projectsKey = () => ["projects"] as const;
export const projectKey = (projectId: number) => ["project", projectId] as const;

export const taskListKey = (projectId: number, viewId?: number | null) =>
  ["tasks", projectId, viewId ?? null] as const;

export const taskKey = (key: string) => ["task", key] as const;

export const viewsKey = () => ["views"] as const;

export const usersKey = () => ["users"] as const;

export const recurringKey = (projectId: number) =>
  ["recurring", projectId] as const;
