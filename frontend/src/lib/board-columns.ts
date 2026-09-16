import type { Column, ColumnKind, Project, Task } from "./types";

/** Standard column names and their canonical order. */
const STANDARD_COLUMNS = [
  { name: "Backlog", order: 0, is_done: false, kind: "backlog" },
  { name: "Todo", order: 1, is_done: false, kind: "todo" },
  { name: "In Progress", order: 2, is_done: false, kind: "in_progress" },
  { name: "In Review", order: 3, is_done: false, kind: "review" },
  { name: "Done", order: 4, is_done: true, kind: "done" },
  { name: "Other", order: 5, is_done: false, kind: "other" },
] as const satisfies readonly {
  name: string;
  order: number;
  is_done: boolean;
  kind: ColumnKind;
}[];

export function boardColumns(project?: Project, columnName?: string | null): Column[] {
  if (project) {
    return project.columns.filter(c => !columnName || c.name.toLowerCase() === columnName.toLowerCase())
      .sort((a, b) => a.order - b.order);
  }
  return STANDARD_COLUMNS.map((column, i) => ({ ...column, id: -(i + 1), project: 0 }));
}

/** A shared-stage reorder keeps the task in its existing project column. */
export function destinationColumns(task: Task, display: Column, projects: Project[]): Column[] {
  const columns = projects.find(p => p.id === task.project)?.columns ?? [];
  if (display.id > 0) return columns.filter(c => c.id === display.id);
  const matching = columns.filter(c => c.kind === display.kind).sort((a, b) => a.order - b.order);
  const current = matching.find(c => c.id === task.column?.id);
  return current ? [current] : matching;
}
