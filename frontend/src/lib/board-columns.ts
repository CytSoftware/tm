import type { Column, ColumnKind, Project, Task } from "./types";

/** Standard column names and their canonical order. */
const STANDARD_COLUMNS = [
  { name: "Backlog", order: 0, is_done: false, kind: "backlog" },
  { name: "Todo", order: 1, is_done: false, kind: "todo" },
  { name: "In Progress", order: 2, is_done: false, kind: "in_progress" },
  { name: "In Review", order: 4, is_done: false, kind: "review" },
  { name: "Done", order: 5, is_done: true, kind: "done" },
  { name: "Other", order: 7, is_done: false, kind: "other" },
  { name: "Cancelled", order: 6, is_done: false, kind: "cancelled" },
  // Appended, not spliced in at order 3: the negative id below is derived from
  // array position and persists in board_column_prefs, so inserting would
  // repoint every later stage's saved visibility. `order` does the sorting.
  { name: "Waiting", order: 3, is_done: false, kind: "waiting" },
] as const satisfies readonly {
  name: string;
  order: number;
  is_done: boolean;
  kind: ColumnKind;
}[];

// A ColumnKind with no stage here silently vanishes from the all-projects
// board — that is exactly how "Waiting" went missing after it was added
// backend-side. Exclude<> is non-empty when a kind is unstaged, and a
// non-never type fails this alias, so `next build` breaks instead.
type AssertNever<T extends never> = T;
type _EveryKindHasAStage = AssertNever<
  Exclude<ColumnKind, (typeof STANDARD_COLUMNS)[number]["kind"]>
>;

export function boardColumns(project?: Project, columnName?: string | null): Column[] {
  if (project) {
    return project.columns.filter(c => !columnName || c.name.toLowerCase() === columnName.toLowerCase())
      .sort((a, b) => a.order - b.order);
  }
  // IDs persist in visibility preferences; append new stages before sorting.
  return STANDARD_COLUMNS.map((column, i) => ({ ...column, id: -(i + 1), project: 0 }))
    .sort((a, b) => a.order - b.order);
}

/** The shared "Other" stage is a catch-all: worth a track slot only while it
 *  holds something. An unloaded column counts as empty so it never flashes in
 *  and out on first paint. Real project columns always show, empty or not. */
export function isEmptyOtherStage(column: Pick<Column, "id" | "kind">, taskCount: number): boolean {
  return column.id < 0 && column.kind === "other" && taskCount === 0;
}

export function isCustomColumn(column: Pick<Column, "name" | "kind">): boolean {
  const stage = STANDARD_COLUMNS.find(c => c.kind === column.kind);
  return column.name.trim().toLowerCase() !== stage?.name.toLowerCase();
}

/** A shared-stage reorder keeps the task in its existing project column. */
export function destinationColumns(task: Task, display: Column, projects: Project[]): Column[] {
  const columns = projects.find(p => p.id === task.project)?.columns ?? [];
  if (display.id > 0) return columns.filter(c => c.id === display.id);
  const matching = columns.filter(c => c.kind === display.kind).sort((a, b) => a.order - b.order);
  const current = matching.find(c => c.id === task.column?.id);
  return current ? [current] : matching;
}
