"use client";

/**
 * Dashboard task inbox — open tasks assigned to me across every project,
 * bucketed by due date (local timezone, day granularity): Overdue, Due soon
 * (next 7 days), Later (capped), No due date (capped, most recently touched
 * first). Rows open the global task overlay in place.
 */

import { useMemo } from "react";
import { CheckSquare } from "lucide-react";

import { useMyTasksQuery } from "@/hooks/use-tasks";
import { useTaskDialog } from "@/lib/task-dialog";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";

const DAY_MS = 86_400_000;
const LATER_CAP = 5;
const UNDATED_CAP = 10;

/** Start of the local day the ISO timestamp falls on. */
function dayOf(iso: string): number {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dueChip(iso: string): { label: string; tone: "overdue" | "soon" | "later" } {
  const today = dayOf(new Date().toISOString());
  const due = dayOf(iso);
  const days = Math.round((due - today) / DAY_MS);
  if (days < 0) {
    const ago = -days;
    return { label: ago === 1 ? "yesterday" : `${ago}d overdue`, tone: "overdue" };
  }
  if (days === 0) return { label: "Today", tone: "soon" };
  if (days === 1) return { label: "Tomorrow", tone: "soon" };
  if (days < 7)
    return {
      label: new Date(iso).toLocaleDateString(undefined, { weekday: "short" }),
      tone: "soon",
    };
  return {
    label: new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
    tone: "later",
  };
}

type Bucket = { title: string; tasks: Task[]; overflow: number };

function bucketize(tasks: Task[]): Bucket[] {
  const today = dayOf(new Date().toISOString());
  const overdue: Task[] = [];
  const soon: Task[] = [];
  const later: Task[] = [];
  const undated: Task[] = [];

  for (const t of tasks) {
    if (t.due_at == null) {
      undated.push(t);
      continue;
    }
    const days = Math.round((dayOf(t.due_at) - today) / DAY_MS);
    if (days < 0) overdue.push(t);
    else if (days < 7) soon.push(t);
    else later.push(t);
  }
  // The server sorts by due_at; undated rows are more useful most recently
  // touched first.
  undated.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return [
    { title: "Overdue", tasks: overdue, overflow: 0 },
    { title: "Due soon", tasks: soon, overflow: 0 },
    {
      title: "Later",
      tasks: later.slice(0, LATER_CAP),
      overflow: Math.max(0, later.length - LATER_CAP),
    },
    {
      title: "No due date",
      tasks: undated.slice(0, UNDATED_CAP),
      overflow: Math.max(0, undated.length - UNDATED_CAP),
    },
  ].filter((b) => b.tasks.length > 0);
}

export function MyTasks() {
  const tasksQuery = useMyTasksQuery();
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const buckets = useMemo(() => bucketize(tasks), [tasks]);

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <CheckSquare className="size-3" />
        My tasks
        {tasks.length > 0 && (
          <span className="tabular-nums normal-case tracking-normal">
            · {tasks.length}
          </span>
        )}
      </h2>

      <div className="rounded-lg border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        {tasksQuery.isLoading ? (
          <div className="grid place-items-center py-12">
            <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
          </div>
        ) : buckets.length === 0 ? (
          <div className="py-10 px-6 text-center text-[12px] text-muted-foreground">
            Nothing assigned to you — enjoy the quiet.
          </div>
        ) : (
          <div className="px-3 py-2.5 space-y-3">
            {buckets.map((bucket) => (
              <div key={bucket.title}>
                <h3 className="px-1.5 mb-0.5 flex items-baseline gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  {bucket.title}
                  <span className="tabular-nums">{bucket.tasks.length}</span>
                </h3>
                <ul>
                  {bucket.tasks.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
                {bucket.overflow > 0 && (
                  <p className="px-1.5 pt-0.5 text-[11px] text-muted-foreground/70">
                    +{bucket.overflow} more
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TaskRow({ task }: { task: Task }) {
  const { openTaskByKey } = useTaskDialog();
  const chip = task.due_at ? dueChip(task.due_at) : null;

  return (
    <li>
      <button
        type="button"
        onClick={() => void openTaskByKey(task.key)}
        className="w-full flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/50 transition-colors"
      >
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: task.project_color ?? "var(--muted-foreground)" }}
          title={task.project_name ?? undefined}
        />
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">
          {task.key}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          {task.title}
        </span>
        {chip && (
          <span
            className={cn(
              "shrink-0 text-[10.5px] font-medium tabular-nums",
              chip.tone === "overdue" &&
                "text-red-600 dark:text-red-400",
              chip.tone === "soon" &&
                "text-amber-600 dark:text-amber-400",
              chip.tone === "later" && "text-muted-foreground",
            )}
          >
            {chip.label}
          </span>
        )}
      </button>
    </li>
  );
}
