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

/** Cross-project "my open tasks" (dashboard inbox). Lives under the
 *  ["tasks"] namespace so existing mutation/WS invalidations refresh it. */
export const myTasksKey = () => ["tasks", "mine"] as const;

/** Cross-project "to review" page (reviewer=me). Lives under the ["tasks"]
 *  namespace so existing mutation/WS invalidations refresh it. */
export const toReviewKey = () => ["tasks", "to-review"] as const;

/** Cross-project unclaimed reviews (reviewer=none in review-kind columns).
 *  Lives under ["tasks"] so mutation invalidations refresh it. */
export const unclaimedReviewsKey = () => ["tasks", "unclaimed-reviews"] as const;

export const viewsKey = () => ["views"] as const;

export const usersKey = () => ["users"] as const;

export const recurringKey = (projectId: number) =>
  ["recurring", projectId] as const;

export const focusKey = () => ["focus"] as const;

// Bets (Cyt OS) — everything under ["bets"] so bet.* WS events / mutations
// can invalidate the whole namespace at once. `projectId` is a project id,
// `"all"` for the cross-project view, or `null` when the query is disabled.
export const betsKey = (projectId: number | "all" | null, period: string) =>
  ["bets", projectId, period] as const;

// Wiki — hierarchical docs (workspace-global). Everything lives under the
// ["wiki"] namespace so the tree socket can invalidate it all at once.
export const wikiTreeKey = (filtersKey = "") =>
  ["wiki", "tree", filtersKey] as const;
export const wikiDocKey = (key: string) => ["wiki", "doc", key] as const;

// Drive — B2 object browser (no realtime; mutations invalidate ["drive"]).
export const driveListKey = (prefix = "") => ["drive", "list", prefix] as const;

// LLM Wiki — read-only markdown pages in B2 (llm-wiki/ prefix); agents write.
export const llmWikiListKey = () => ["llm-wiki", "list"] as const;
export const llmWikiPageKey = (slug: string) =>
  ["llm-wiki", "page", slug] as const;

// Notifications — per-user inbox. The list query's response also carries
// `unread_count`, so `notificationsUnreadKey` is only used by the
// standalone `/api/notifications/unread_count/` poll (WS fallback).
export const notificationsKey = () => ["notifications", "list"] as const;
export const notificationsUnreadKey = () =>
  ["notifications", "unread-count"] as const;

// Outbound webhooks — per-user endpoints. Deliveries live under the same
// ["webhooks"] namespace but are fetched lazily per endpoint on expand.
export const webhooksKey = () => ["webhooks"] as const;
export const webhookDeliveriesKey = (endpointId: number) =>
  ["webhooks", endpointId, "deliveries"] as const;

// Analytics. `projectId` null = all projects.
export const throughputKey = (
  projectId: number | null,
  from: string,
  to: string,
  tz: string,
) => ["analytics", "throughput", projectId, from, to, tz] as const;

// `weekStart` is the Monday of the selected week ("current" sentinel when
// following the live current week rather than a pinned date).
export const weeklyCompletionsKey = (
  projectId: number | null,
  weekStart: string,
  weeks: number,
  tz: string,
) => ["analytics", "completions", projectId, weekStart, weeks, tz] as const;

// Inbound event inbox.
export const eventSourcesKey = () => ["event-sources"] as const;
export const externalEventsKey = (filters: {
  source?: number;
  workflow_status?: string;
  search?: string;
}) => ["external-events", "list", filters] as const;
export const externalEventSummaryKey = (source?: number) =>
  ["external-events", "summary", source ?? "all"] as const;

// Workspace-wide external service directory.
export const infrastructureServicesKey = () =>
  ["infrastructure-services"] as const;
