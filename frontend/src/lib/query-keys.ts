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

export const focusKey = () => ["focus"] as const;

// Pipelines (separate from tasks — global, no per-project scoping in v1).
export const pipelineStagesKey = () => ["pipeline-stages"] as const;
export const pipelineListKey = (filtersKey: string) =>
  ["pipelines", filtersKey] as const;
export const pipelineKey = (key: string) => ["pipeline", key] as const;
export const pipelineEventsKey = (key: string) =>
  ["pipeline-events", key] as const;

// CRM — flat contact table (no realtime in v1; no project scoping).
export const contactLabelsKey = () => ["contact-labels"] as const;
/** List key includes filters + sort + page so each unique view caches
 *  independently. ``filtersKey`` is the JSON-stringified state. */
export const contactListKey = (
  filtersKey: string,
  sortField: string | null,
  sortDir: string | null,
  page: number,
  pageSize: number,
) =>
  [
    "contacts",
    filtersKey,
    sortField ?? "",
    sortDir ?? "",
    page,
    pageSize,
  ] as const;
export const contactKey = (key: string) => ["contact", key] as const;

// Wiki — hierarchical docs (workspace-global). Everything lives under the
// ["wiki"] namespace so the tree socket can invalidate it all at once.
export const wikiTreeKey = (filtersKey = "") =>
  ["wiki", "tree", filtersKey] as const;
export const wikiDocKey = (key: string) => ["wiki", "doc", key] as const;

// Drive — B2 object browser (no realtime; mutations invalidate ["drive"]).
export const driveListKey = (prefix = "") => ["drive", "list", prefix] as const;
