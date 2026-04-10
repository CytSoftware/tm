/**
 * API type definitions — hand-written for Phase 1 speed.
 *
 * Keep this file in sync with `backend/apps/tasks/serializers.py`. When the
 * two drift we regenerate from `/api/schema/` via `openapi-typescript` in a
 * later phase.
 */

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

export const PRIORITY_ORDER: Priority[] = ["URGENT", "HIGH", "MEDIUM", "LOW"];

export type User = {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_url: string;
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
  task_counter: number;
  columns: Column[];
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: number;
  key: string;
  title: string;
  description: string;
  project: number;
  project_prefix: string;
  project_name: string;
  column: Column;
  position: number;
  assignee: User | null;
  reporter: User | null;
  labels: Label[];
  priority: Priority;
  story_points: number | null;
  recurrence_template: number | null;
  is_recurring_instance: boolean;
  due_at: string | null;
  created_at: string;
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
  field: "created_at" | "updated_at" | "due_at" | "title" | "position" | "story_points" | "priority";
  dir: "asc" | "desc";
}>;

/** Field names that can be toggled on/off for Kanban card display. */
export type CardField =
  | "key"
  | "title"
  | "priority"
  | "assignee"
  | "labels"
  | "points"
  | "due_date"
  | "project";

export const ALL_CARD_FIELDS: CardField[] = [
  "key",
  "title",
  "priority",
  "assignee",
  "labels",
  "points",
  "due_date",
  "project",
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

export type RecurringTaskTemplate = {
  id: number;
  project: number;
  project_prefix: string;
  title: string;
  description: string;
  assignee: User | null;
  labels: Label[];
  column: Column;
  priority: Priority;
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

/** The event the Channels consumer pushes for every task mutation. */
export type TaskEvent =
  | { type: "connected"; project_id: number }
  | { type: "task.created"; key: string; id: number }
  | { type: "task.updated"; key: string; id: number }
  | { type: "task.moved"; key: string; id: number; column_id: number }
  | { type: "task.deleted"; key: string };
