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

export type Column = {
  id: number;
  project: number;
  name: string;
  order: number;
  is_done: boolean;
};

export type Label = {
  id: number;
  project: number;
  name: string;
  color: string;
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
  | { type: "column.reordered"; columns: Column[] };

// ─────────────────────────────────────────────────────────────────────────
// Pipelines — long-running tracked processes (separate from Tasks).
// ─────────────────────────────────────────────────────────────────────────

export type Stage = {
  id: number;
  name: string;
  order: number;
  color: string;
  is_terminal: boolean;
};

export type PipelineEventEntry = {
  id: number;
  pipeline: number;
  body: string;
  author: User | null;
  created_at: string;
};

export type Pipeline = {
  id: number;
  key: string;
  title: string;
  description: string;
  counterparty: string;
  stage: Stage;
  position: number;
  owner: User | null;
  created_by: User | null;
  event_count: number;
  last_event_at: string | null;
  last_event_body: string | null;
  created_at: string;
  updated_at: string;
};

export type PipelineDetail = Pipeline & {
  events: PipelineEventEntry[];
};

export type PipelineListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: Pipeline[];
};

export type PipelineEvent =
  | { type: "connected" }
  | { type: "pipeline.created"; key: string; id: number }
  | { type: "pipeline.updated"; key: string; id: number }
  | { type: "pipeline.moved"; key: string; id: number; stage_id: number }
  | { type: "pipeline.deleted"; key: string }
  | {
      type: "pipeline.event_added";
      key: string;
      id: number;
      event_id: number;
    };

// ─────────────────────────────────────────────────────────────────────────
// CRM — flat contact table.
// Schema is fixed (no per-contact custom fields); every column is a real
// filter / sort target. Labels are an extendable M2M.
// ─────────────────────────────────────────────────────────────────────────

export type ContactLabel = {
  id: number;
  name: string;
  color: string;
  created_at: string;
};

/** Allowed keys on `Contact.socials`. Mirrors `ALLOWED_SOCIAL_KEYS` in
 *  `backend/apps/crm/models.py` — extending requires changes on both ends. */
export const SOCIAL_KEYS = [
  "linkedin",
  "twitter",
  "instagram",
  "facebook",
] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];
export const SOCIAL_LABELS: Record<SocialKey, string> = {
  linkedin: "LinkedIn",
  twitter: "Twitter / X",
  instagram: "Instagram",
  facebook: "Facebook",
};

export type Contact = {
  id: number;
  key: string;
  company: string;
  first_name: string;
  last_name: string;
  /** Type of company — free-text (e.g. "Banking", "SaaS"). */
  industry: string;
  /** Person's role — free-text (e.g. "CEO", "Engineer"). */
  job_title: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  /** ISO 3166-1 alpha-2 (e.g. "US", "FR"). Empty string when unknown. */
  country: string;
  websites: string[];
  socials: Partial<Record<SocialKey, string>>;
  labels: ContactLabel[];
  notes: string;
  created_by: User | null;
  created_at: string;
  updated_at: string;
};

export type ContactListResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: Contact[];
};

/** Sortable columns on the contacts table. Must match `SORTABLE_FIELDS`
 *  in `apps/crm/query.py`. */
export type ContactSortField =
  | "company"
  | "first_name"
  | "last_name"
  | "email"
  | "country"
  | "city"
  | "industry"
  | "job_title"
  | "key"
  | "created_at"
  | "updated_at";

export const CONTACT_SORT_LABELS: Record<ContactSortField, string> = {
  company: "Company",
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  country: "Country",
  city: "City",
  industry: "Industry",
  job_title: "Job title",
  key: "Contact #",
  created_at: "Created",
  updated_at: "Last updated",
};

export type ContactFilters = {
  search: string;
  country: string;
  city: string;
  /** Free-text substring match on Contact.industry. */
  industry: string;
  /** Free-text substring match on Contact.job_title. */
  jobTitle: string;
  labelIds: number[];
  hasEmail: boolean | null;
  hasPhone: boolean | null;
  hasLinkedin: boolean | null;
  hasWebsite: boolean | null;
};

export const EMPTY_CONTACT_FILTERS: ContactFilters = {
  search: "",
  country: "",
  city: "",
  industry: "",
  jobTitle: "",
  labelIds: [],
  hasEmail: null,
  hasPhone: null,
  hasLinkedin: null,
  hasWebsite: null,
};

/** Backend response from `/api/contacts/import-preview/`. */
export type ContactImportPreview = {
  token: string;
  /** ``"csv"`` or ``"xlsx"``. Determined by magic bytes / extension on the
   *  server. Old ``.xls`` is rejected up front. */
  format: "csv" | "xlsx";
  headers: string[];
  sample_rows: string[][];
  row_count: number;
  /** For CSV: the detected delimiter (``,``/``;``/``\t``). For XLSX: the
   *  literal string ``"xlsx"`` (no delimiter concept). */
  delimiter: string;
  /** Header → target field. Unknown headers are mapped to `"[ignore]"`. */
  suggested_mapping: Record<string, string>;
  /** Catalogue of valid mapping targets. Useful for the dropdown options. */
  valid_targets: string[];
};

export type ContactImportResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; reason: string }[];
};

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
