/**
 * API type definitions — hand-written for Phase 1 speed.
 *
 * Keep this file in sync with `backend/apps/tasks/serializers.py`. When the
 * two drift we regenerate from `/api/schema/` via `openapi-typescript` in a
 * later phase.
 */

// P1 is the highest priority, P4 is the lowest. Matches the "P1 = critical"
// convention used everywhere outside the tracker.
export type Priority = "P1" | "P2" | "P3" | "P4";

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: "P1",
  P2: "P2",
  P3: "P3",
  P4: "P4",
};

export const PRIORITY_ORDER: Priority[] = ["P1", "P2", "P3", "P4"];

/** Solid dot color per priority (Tailwind `bg-*` class) — used by compact UI
 *  like the kanban card footer and its inline priority popover. */
export const PRIORITY_DOT: Record<Priority, string> = {
  P1: "bg-red-500",
  P2: "bg-orange-500",
  P3: "bg-blue-500",
  P4: "bg-muted-foreground/40",
};

export type User = {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
};

/** Per-project kanban column visibility, keyed by *string* project id (the
 *  all-projects board uses ``"0"`` since it has no real project). Column ids
 *  can be the negative virtual ids used by the all-projects board's
 *  STANDARD_COLUMNS — the backend accepts any ints. */
export type BoardColumnPrefs = Record<string, { hidden_columns: number[] }>;

/** User-private preferences — only returned by ``/api/auth/me/``. Not
 *  exposed on the shared ``/api/users/`` listing. */
export type MePreferences = {
  /** Arbitrary key -> user-id map for the Assign-Todo triage dialog. Keys
   *  are normalized ``KeyboardEvent.key`` values (letters uppercased; arrow
   *  keys stay as ``ArrowLeft`` / ``ArrowRight`` / ``ArrowUp``). Each user
   *  can be bound to at most one key; each key to one user. */
  assign_hotkey_bindings: Record<string, number>;
  /** Collapsed/hidden kanban columns per project — see ``BoardColumnPrefs``. */
  board_column_prefs: BoardColumnPrefs;
};

export type Me = User & {
  preferences: MePreferences;
};

/** Semantic column kind — a fixed vocabulary independent of the column's
 *  (renameable) display name. Server-derives `is_done` from `kind === "done"`. */
export type ColumnKind =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "done"
  | "other";

export const COLUMN_KIND_ORDER: ColumnKind[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "other",
];

export const COLUMN_KIND_LABELS: Record<ColumnKind, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
  other: "Other",
};

export type Column = {
  id: number;
  project: number;
  name: string;
  order: number;
  is_done: boolean;
  kind: ColumnKind;
};

export type Label = {
  id: number;
  project: number;
  name: string;
  color: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Bets (Cyt OS) — project-specific bets on a fixed two-month period grid
// (anchored 2026-07-01). Tasks link to the bet they serve; progress is
// tracked per bet via metrics with an append-only check-in log.
// ─────────────────────────────────────────────────────────────────────────

export type BetStatus = "active" | "won" | "lost";

export const BET_STATUS_LABELS: Record<BetStatus, string> = {
  active: "Active",
  won: "Won",
  lost: "Lost",
};

/** Chip tint per bet status — shared by the bets page and the dashboard. */
export const BET_STATUS_TONE: Record<BetStatus, string> = {
  active: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/30",
  won: "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30",
  lost: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/30",
};

export type MetricCheckin = {
  id: number;
  metric: number;
  /** Optional numeric reading — qualitative metrics log notes instead. */
  value: number | null;
  note: string;
  created_by: User | null;
  created_at: string;
  updated_at: string;
};

export type BetMetric = {
  id: number;
  bet: number;
  name: string;
  target: number | null;
  unit: string;
  /** Newest first (server ordering). The head is the current reading. */
  checkins: MetricCheckin[];
  created_at: string;
  updated_at: string;
};

export type Bet = {
  id: number;
  project: number;
  project_name: string;
  name: string;
  description: string;
  color: string;
  status: BetStatus;
  /** First day of the bet's two-month period (ISO date). */
  period_start: string;
  /** Human label like "Jul–Aug 2026". */
  period_label: string;
  /** Exclusive period end (ISO date). */
  period_end: string;
  metrics: BetMetric[];
  task_count: number;
  done_task_count: number;
  tasks: BetTaskRef[];
  created_at: string;
  updated_at: string;
};

/** Compact bet reference embedded on task reads (card chip data). */
export type BetRef = {
  id: number;
  name: string;
  color: string;
  status: BetStatus;
  period_start: string;
};

/** Compact task reference embedded on bet reads (bets page task list). */
export type BetTaskRef = {
  id: number;
  key: string;
  title: string;
  column: string | null;
  is_done: boolean;
  priority: Priority | null;
};

export type Project = {
  id: number;
  name: string;
  prefix: string;
  description: string;
  color: string;
  icon: string;
  archived: boolean;
  /** GitHub repo in "owner/repo" form. Empty string when no repo is linked.
   *  Used by the project header to render an outbound link, and reserved as
   *  the lookup key for the GitHub PR-review webhook (TAS-010 / TAS-011). */
  github_repo: string;
  task_counter: number;
  columns: Column[];
  is_starred: boolean;
  /** This user's manual sidebar ordering index, or null if never reordered.
   *  Lower sorts first; nulls sort last (then by name). Per-user. */
  sidebar_position: number | null;
  created_at: string;
  updated_at: string;
};

export type LinkedPRRepository = {
  id: number;
  repo_id: number;
  repo_full_name: string;
  default_branch: string;
};

export type LinkedPR = {
  id: number;
  pr_number: number;
  pr_title: string;
  /** GitHub PR state. "closed" + merged=true is how GitHub represents a merge. */
  state: "open" | "closed";
  merged: boolean;
  is_draft: boolean;
  head_ref: string;
  base_ref: string;
  html_url: string;
  author_login: string;
  repository: LinkedPRRepository | null;
  opened_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
};

export type Task = {
  id: number;
  key: string;
  title: string;
  description: string;
  project: number | null;
  project_prefix: string | null;
  project_name: string | null;
  project_color: string | null;
  column: Column | null;
  position: number;
  assignees: User[];
  reporter: User | null;
  labels: Label[];
  /** The bet this task serves (Cyt OS), or null when unlinked. */
  bet: BetRef | null;
  /** null = task has no priority set; sorts last in priority-desc order. */
  priority: Priority | null;
  story_points: number | null;
  recurrence_template: number | null;
  is_recurring_instance: boolean;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  /** ISO timestamp of the most recent transition *into* the current column.
   *  Null for columnless tasks or legacy rows with no transition log. */
  current_column_since: string | null;
  /** Derived staleness badge: yellow = past yellow_days, red = past red_days.
   *  Null means not configured or in a Done column. */
  staleness: "yellow" | "red" | null;
  /** GitHub PRs linked to this task (empty array when none). */
  linked_prs: LinkedPR[];
};

export type StateTransition = {
  id: number;
  from_column: Column | null;
  to_column: Column | null;
  at: string;
  triggered_by: User | null;
  source: "user" | "mcp" | "recurring" | "backfill";
};

export type StalenessSettings = {
  thresholds: Record<string, { yellow_days?: number; red_days?: number }>;
  defaults: Record<string, { yellow_days?: number; red_days?: number }>;
  updated_at: string;
};

export type TaskListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: Task[];
};

export type ProjectListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: Project[];
};

export type ViewListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: SavedView[];
};

export type RecurringListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: RecurringTaskTemplate[];
};

export type SavedViewFilters = {
  project?: string | number | null;
  assignee?: (string | number)[] | null;
  priority?: Priority[] | null;
  labels?: (string | number)[] | null;
  column?: string | number | null;
  search?: string | null;
  /** All-projects board only: include tasks from archived projects. Absent /
   *  false hides them; true shows them. */
  include_archived?: boolean | null;
};

export type SavedViewSort = Array<{
  field:
    | "created_at"
    | "updated_at"
    | "due_at"
    | "title"
    | "position"
    | "story_points"
    | "priority"
    | "staleness"
    | "current_column_since";
  dir: "asc" | "desc";
}>;

export type SortField = SavedViewSort[number]["field"];

export const SORT_FIELDS: SortField[] = [
  "updated_at",
  "created_at",
  "due_at",
  "priority",
  "staleness",
  "title",
  "story_points",
  "position",
];

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  updated_at: "Last updated",
  created_at: "Created",
  due_at: "Due date",
  priority: "Priority",
  staleness: "Staleness",
  title: "Title",
  story_points: "Story points",
  position: "Manual order",
  current_column_since: "Entered column",
};

/** In-memory state for the FilterBar — superset of SavedViewFilters + sort. */
export type BoardFilters = {
  project: number | null;
  priorities: Priority[];
  assigneeIds: number[];
  includeUnassigned: boolean;
  labelIds: number[];
  columnName: string | null;
  search: string;
  /** All-projects board: include tasks from archived projects. Defaults to
   *  false so archived-project tasks stay hidden until explicitly shown. */
  includeArchived: boolean;
  sort: SavedViewSort;
};

export const EMPTY_BOARD_FILTERS: BoardFilters = {
  project: null,
  priorities: [],
  assigneeIds: [],
  includeUnassigned: false,
  labelIds: [],
  columnName: null,
  search: "",
  includeArchived: false,
  // Default to manual position order — the sort the kanban drag-and-drop
  // actually mutates. Users who want a different sort can flip it via the
  // SortPopover; doing so changes the query key and triggers a fresh fetch,
  // which is expected behavior for a deliberate sort change.
  sort: [{ field: "position", dir: "asc" }],
};

/** Field names that can be toggled on/off for Kanban card display. */
export type CardField =
  | "key"
  | "title"
  | "priority"
  | "assignee"
  | "labels"
  | "bet"
  | "points"
  | "due_date"
  | "project"
  | "linked_pr";

export const ALL_CARD_FIELDS: CardField[] = [
  "key",
  "title",
  "priority",
  "assignee",
  "labels",
  "bet",
  "points",
  "due_date",
  "project",
  "linked_pr",
];

export const CARD_FIELD_LABELS: Record<CardField, string> = {
  key: "Key",
  title: "Title",
  priority: "Priority",
  assignee: "Assignee",
  labels: "Labels",
  bet: "Bet",
  points: "Story points",
  due_date: "Due date",
  project: "Project prefix",
  linked_pr: "Linked PRs",
};

export type SavedView = {
  id: number;
  owner: number;
  name: string;
  project: number | null;
  kind: "board" | "table";
  filters: SavedViewFilters;
  sort: SavedViewSort;
  shared: boolean;
  card_display: CardField[] | null;
  created_at: string;
  updated_at: string;
};

/** Personal focus list — `/api/me/focus/`. Per-user pin of a task into a
 *  `Today` or `This week` bucket. */
export type FocusPeriod = "day" | "week";

export const FOCUS_PERIOD_LABELS: Record<FocusPeriod, string> = {
  day: "Today",
  week: "This week",
};

export type FocusItem = {
  id: number;
  task: Task;
  period: FocusPeriod;
  position: number;
  created_at: string;
  updated_at: string;
};

export type RecurringTaskTemplate = {
  id: number;
  project: number;
  project_prefix: string;
  title: string;
  description: string;
  assignees: User[];
  labels: Label[];
  column: Column;
  priority: Priority | null;
  story_points: number | null;
  rrule: string;
  dtstart: string;
  timezone: string;
  next_run_at: string;
  last_generated_at: string | null;
  active: boolean;
  created_by: User | null;
  created_at: string;
  updated_at: string;
};

/** The event the Channels consumer pushes for every task or column mutation. */
export type TaskEvent =
  | { type: "connected"; project_id: number }
  | { type: "task.created"; key: string; id: number }
  | { type: "task.updated"; key: string; id: number }
  | { type: "task.moved"; key: string; id: number; column_id: number }
  | { type: "task.deleted"; key: string }
  | { type: "column.created"; column: Column }
  | { type: "column.updated"; column: Column }
  | { type: "column.deleted"; column_id: number }
  | { type: "column.reordered"; columns: Column[] }
  | { type: "bet.created"; bet_id: number }
  | { type: "bet.updated"; bet_id: number }
  | { type: "bet.deleted"; bet_id: number };

// ─────────────────────────────────────────────────────────────────────────
// Wiki — hierarchical, workspace-global docs (Notion-style page tree).
// Body content is edited collaboratively (Plate + Yjs) over a dedicated
// socket; the REST surface carries only the tree + a denormalized snapshot.
// ─────────────────────────────────────────────────────────────────────────

/** A Plate/Slate document value — an array of nodes. Kept loose here so the
 *  shared types file doesn't depend on Plate. The editor casts it. */
export type WikiValue = unknown[];

export type WikiDoc = {
  id: number;
  key: string;
  title: string;
  parent: number | null;
  position: number;
  project: number | null;
  created_by: User | null;
  last_edited_by: User | null;
  has_children: boolean;
  created_at: string;
  updated_at: string;
};

/** Returned by the retrieve-by-key endpoint; adds the body snapshot. */
export type WikiDocDetail = WikiDoc & {
  content: WikiValue;
};

export type WikiEvent =
  | { type: "connected" }
  | { type: "wiki.created"; key: string; id: number; parent_id: number | null }
  | { type: "wiki.updated"; key: string; id: number; parent_id: number | null }
  | { type: "wiki.moved"; key: string; id: number; parent_id: number | null }
  | { type: "wiki.deleted"; key: string };

// ─────────────────────────────────────────────────────────────────────────
// Notifications — per-user inbox of task events (assigned/updated/moved/
// completed/deleted). REST list is paginated; live updates arrive over
// `ws/notifications/`. See `apps/tasks/notifications.py` on the backend.
// ─────────────────────────────────────────────────────────────────────────

export type NotificationVerb =
  | "assigned"
  | "updated"
  | "moved"
  | "completed"
  | "deleted";

/** Minimal actor shape the notification serializer embeds — not the full
 *  `User` (no email/avatar). `null` means a system-generated event (e.g. the
 *  recurring-task generator). */
export type NotificationActor = {
  id: number;
  username: string;
};

export type NotificationProject = {
  id: number;
  name: string;
};

/** Shape varies by verb: `updated` carries `changed_fields`, `moved` carries
 *  `from_column`/`to_column`. Other verbs send `{}`. */
export type NotificationPayload = {
  changed_fields?: string[];
  from_column?: string | null;
  to_column?: string | null;
};

export type Notification = {
  id: number;
  verb: NotificationVerb;
  task_key: string;
  task_title: string;
  project: NotificationProject | null;
  actor: NotificationActor | null;
  payload: NotificationPayload;
  read_at: string | null;
  created_at: string;
};

export type NotificationListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: Notification[];
  /** Piggybacked on every list response so the bell badge doesn't need a
   *  separate round trip on first paint. */
  unread_count: number;
};

/** WS message shape on `ws/notifications/`. The `notification` variant is
 *  a `Notification` plus the discriminant `type` field, sent flat (not
 *  nested) — see `NotificationConsumer.notify_event` on the backend. */
export type NotificationEvent =
  | { type: "connected" }
  | ({ type: "notification" } & Notification);

// ─────────────────────────────────────────────────────────────────────────
// Outbound webhooks — per-user endpoints that receive task events
// (assigned/updated/moved/completed/deleted/created) as signed HTTP POSTs.
// See `apps/webhooks` on the backend. `event_types: []` means "all events".
// ─────────────────────────────────────────────────────────────────────────

/** "mine" (default) fires only for events involving the owner (recipient or
 *  actor via `include_self`); "all" fires workspace-wide regardless of who
 *  acted or was assigned. */
export type WebhookScope = "mine" | "all";

/** Webhook event types are a superset of `NotificationVerb` — "created" is
 *  webhook-only and never appears in the in-app notification inbox. */
export type WebhookEventType = NotificationVerb | "created";

export type WebhookEndpoint = {
  id: number;
  name: string;
  url: string;
  /** Subset of `WebhookEventType` values; empty = fire for every event. */
  event_types: WebhookEventType[];
  /** Scope to one project, or null for all projects. */
  project: number | null;
  /** Also fire for the owner's own actions (personal-agent use case).
   *  Ignored when `scope === "all"`. */
  include_self: boolean;
  /** "mine" = owner-scoped (default); "all" = org-wide. */
  scope: WebhookScope;
  active: boolean;
  consecutive_failures: number;
  /** Set when the endpoint was auto-disabled after repeated failures. */
  disabled_at: string | null;
  created_at: string;
};

/** Shape of the POST /api/webhooks/ (create) response only — the plaintext
 *  secret is reveal-once and never included on GET/list/PATCH responses. */
export type WebhookEndpointCreated = WebhookEndpoint & { secret: string };

export type WebhookDeliveryStatus = "pending" | "success" | "failed";

export type WebhookDelivery = {
  id: string;
  /** e.g. "task.assigned" or "webhook.test". */
  event: string;
  task_key: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  response_status: number | null;
  error: string;
  created_at: string;
};

export type WebhookEndpointListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: WebhookEndpoint[];
};

// ─────────────────────────────────────────────────────────────────────────
// Analytics. Throughput is a zero-filled daily flow series. Weekly
// completions returns the selected week's per-person counts plus a
// zero-filled trailing trend. See `frontend/src/hooks/use-analytics.ts`.
// ─────────────────────────────────────────────────────────────────────────

export type ThroughputDay = {
  date: string;
  created: number;
  started: number;
  in_review: number;
  completed: number;
};

export type ThroughputResponse = {
  days: ThroughputDay[];
};

export type ThroughputMetric =
  | "created"
  | "started"
  | "in_review"
  | "completed";

export const THROUGHPUT_METRICS: ThroughputMetric[] = [
  "created",
  "started",
  "in_review",
  "completed",
];

export const THROUGHPUT_METRIC_LABELS: Record<ThroughputMetric, string> = {
  created: "Created",
  started: "Started",
  in_review: "In review",
  completed: "Completed",
};

/** One row of `per_person` — `user_id: null` is the "Unassigned" bucket,
 *  always sorted last by the server. */
export type CompletionsPerson = {
  user_id: number | null;
  username: string | null;
  avatar_url: string | null;
  count: number;
  prev_count: number;
};

export type CompletionsTrendWeek = {
  week_start: string;
  total: number;
};

export type WeeklyCompletionsResponse = {
  week_start: string;
  week_end: string;
  total: number;
  prev_total: number;
  per_person: CompletionsPerson[];
  trend: CompletionsTrendWeek[];
};
