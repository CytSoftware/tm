"use client";

/**
 * Unified ⌘K palette — commands AND search in one overlay, mounted once in
 * the Shell so it works on every page (open state lives in lib/palette.tsx).
 *
 * Sections:
 *   - Task actions — when the board has a selected task (registered via
 *     `usePalettePageContext`), move/priority/assign/label/open commands for
 *     that task, headed by its key.
 *   - Commands — create task (global), switch project / switch view, plus
 *     whatever the active page registered (e.g. board's create project /
 *     create label dialogs).
 *   - Tasks / Projects — server task search + client project filter, with an
 *     exact key match ("CYT-123") bubbled to the top.
 *   - Recent — recently-opened tasks, shown while the query is empty.
 *
 * Keyboard: ↑/↓ navigate the flat list across sections, Enter runs, Esc
 * closes. Typing filters commands (fuzzy) and searches tasks/projects.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Clock,
  FileText,
  FolderKanban,
  Search,
  Terminal,
} from "lucide-react";

import { apiFetch } from "@/lib/api";
import { viewsKey } from "@/lib/query-keys";
import { useActiveProject } from "@/lib/active-project";
import { useTaskDialog } from "@/lib/task-dialog";
import { usePalette, type PaletteAction } from "@/lib/palette";
import { useRecentTasks, type RecentTask } from "@/lib/recent-tasks";
import { copyTaskId, copyTaskPrompt } from "@/lib/task-copy";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useUsersQuery } from "@/hooks/use-users";
import { useLabelsQuery } from "@/hooks/use-labels";
import type {
  Label,
  Priority,
  Project,
  Task,
  TaskListResponse,
  ViewListResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
};

type Entry =
  | { kind: "task"; id: string; task: Task; exact?: boolean }
  | { kind: "recent"; id: string; recent: RecentTask }
  | { kind: "project"; id: string; project: Project }
  | {
      kind: "action";
      id: string;
      action: PaletteAction;
      /** Which header the row sits under — task-scoped vs. global commands. */
      group: "task" | "commands";
    };

// Task keys look like "ABC-123". Match loosely so partial-typing still
// highlights the exact-match when the user types a full key.
const TASK_KEY_REGEX = /^[a-z0-9]+-\d+$/i;

const PRIORITY_COLORS: Record<Priority, string> = {
  P1: "text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10",
  P2: "text-orange-600 dark:text-orange-400 border-orange-500/30 bg-orange-500/10",
  P3: "text-sky-600 dark:text-sky-400 border-sky-500/30 bg-sky-500/10",
  P4: "text-muted-foreground border-border/60 bg-muted/60",
};

// Fuzzy match — every whitespace-separated word in the query must appear
// somewhere in the target (case-insensitive).
function fuzzyMatch(query: string, target: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = target.toLowerCase();
  return words.every((w) => lower.includes(w));
}

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setProjectId, setViewId } = useActiveProject();
  const { openTask, openTaskByKey, createTask } = useTaskDialog();
  const { pageContext } = usePalette();
  const selectedTask = pageContext?.selectedTask ?? null;

  const projectsQuery = useProjectsQuery();
  const allProjects: Project[] = useMemo(
    () => (projectsQuery.data?.results ?? []).filter((p) => !p.archived),
    [projectsQuery.data],
  );
  const usersQuery = useUsersQuery();
  const labelsQuery = useLabelsQuery();
  const viewsQuery = useQuery({
    queryKey: viewsKey(),
    queryFn: () => apiFetch<ViewListResponse>("/api/views/"),
    enabled: open,
  });

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recentTasks = useRecentTasks();

  // Reset the query/highlight whenever the palette (re)opens — done during
  // render (the "store info from previous renders" pattern, same as
  // Column.tsx's rename draft) so lint's no-sync-setState-in-effect rule
  // stays happy and the reset lands in the same render pass.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setDebounced("");
      setActiveIndex(0);
    }
  }

  // Focus the input on open — next tick so the input exists.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Debounce the search query (200ms)
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(id);
  }, [query, open]);

  // Task search — disabled until the query has real content
  const taskSearch = useQuery<TaskListResponse>({
    queryKey: ["global-search", "tasks", debounced],
    queryFn: () =>
      apiFetch<TaskListResponse>(
        `/api/tasks/?search=${encodeURIComponent(debounced)}&limit=10`,
      ),
    enabled: open && debounced.length >= 1,
    staleTime: 10_000,
  });

  // Client-side project filter against the cached project list
  const filteredProjects = useMemo<Project[]>(() => {
    if (!debounced) return [];
    const q = debounced.toLowerCase();
    return allProjects
      .filter((p) => {
        const prefix = (p.prefix ?? "").toLowerCase();
        const name = (p.name ?? "").toLowerCase();
        return prefix.includes(q) || name.includes(q);
      })
      .slice(0, 5);
  }, [debounced, allProjects]);

  // Refetch everything a command may have touched. Command handlers hit the
  // API directly (they don't go through the board's mutation hooks), so the
  // palette owns cache invalidation for them.
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  }, [queryClient]);

  // Task-scoped commands for the board's selected task.
  const taskActions = useMemo<PaletteAction[]>(() => {
    if (!selectedTask) return [];
    return buildTaskActions(
      selectedTask,
      allProjects,
      usersQuery.data ?? [],
      labelsQuery.data ?? [],
      invalidate,
      openTask,
    );
  }, [
    selectedTask,
    allProjects,
    usersQuery.data,
    labelsQuery.data,
    invalidate,
    openTask,
  ]);

  // Global commands + whatever the active page registered.
  const globalActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = [
      {
        id: "create-task",
        label: "Create task",
        keywords: "new add task",
        handler: () => createTask({ columnId: null }),
      },
      ...(pageContext?.extraActions ?? []),
      {
        id: "switch-project-all",
        label: "Switch project → All projects",
        keywords: "switch project all",
        handler: () => {
          setProjectId(null);
          router.push("/board");
        },
      },
    ];
    for (const p of allProjects) {
      actions.push({
        id: `switch-project-${p.id}`,
        label: `Switch project → ${p.name}`,
        keywords: "switch project",
        handler: () => {
          setProjectId(p.id);
          router.push("/board");
        },
      });
    }
    for (const v of viewsQuery.data?.results ?? []) {
      actions.push({
        id: `switch-view-${v.id}`,
        label: `Switch view → ${v.name}`,
        keywords: "switch view",
        handler: () => {
          setViewId(v.id);
          router.push("/board");
        },
      });
    }
    return actions;
  }, [
    pageContext?.extraActions,
    allProjects,
    viewsQuery.data,
    createTask,
    setProjectId,
    setViewId,
    router,
  ]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const matchesQuery = (a: PaletteAction) =>
      !debounced || fuzzyMatch(debounced, a.label + " " + (a.keywords ?? ""));

    if (debounced) {
      // Search results first — exact key match bubbles to the top.
      const tasks = taskSearch.data?.results ?? [];
      const qUpper = debounced.toUpperCase();
      const exactTask = TASK_KEY_REGEX.test(debounced)
        ? tasks.find((t) => t.key.toUpperCase() === qUpper)
        : undefined;
      if (exactTask) {
        out.push({
          kind: "task",
          id: `task-${exactTask.id}`,
          task: exactTask,
          exact: true,
        });
      }
      for (const t of tasks) {
        if (t.id === exactTask?.id) continue;
        out.push({ kind: "task", id: `task-${t.id}`, task: t });
      }
      for (const p of filteredProjects) {
        out.push({ kind: "project", id: `project-${p.id}`, project: p });
      }
    }

    for (const a of taskActions) {
      if (!matchesQuery(a)) continue;
      out.push({ kind: "action", id: a.id, action: a, group: "task" });
    }
    for (const a of globalActions) {
      if (!matchesQuery(a)) continue;
      out.push({ kind: "action", id: a.id, action: a, group: "commands" });
    }

    if (!debounced) {
      for (const r of recentTasks) {
        out.push({ kind: "recent", id: `recent-${r.id}`, recent: r });
      }
    }
    return out;
  }, [
    debounced,
    taskSearch.data,
    filteredProjects,
    taskActions,
    globalActions,
    recentTasks,
  ]);

  // Reset the highlight to the top whenever the query changes — during
  // render, same pattern as the open reset above.
  const [prevDebounced, setPrevDebounced] = useState(debounced);
  if (prevDebounced !== debounced) {
    setPrevDebounced(debounced);
    setActiveIndex(0);
  }

  // The raw index can point past the end after entries shrink (e.g. search
  // results arriving); clamp at read time instead of chasing it with state.
  const clampedIndex =
    entries.length === 0 ? 0 : Math.min(activeIndex, entries.length - 1);

  // Scroll the active row into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-result-index="${clampedIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  const executeEntry = useCallback(
    (entry: Entry) => {
      onClose();
      if (entry.kind === "task") {
        openTask(entry.task);
      } else if (entry.kind === "recent") {
        // The cached snapshot may be stale — refetch by key so labels,
        // description, etc. reflect the current state.
        void openTaskByKey(entry.recent.key);
      } else if (entry.kind === "project") {
        setProjectId(entry.project.id);
        setViewId(null);
        router.push("/board");
      } else {
        entry.action.handler();
      }
    },
    [onClose, openTask, openTaskByKey, setProjectId, setViewId, router],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex(
            entries.length === 0
              ? 0
              : Math.min(clampedIndex + 1, entries.length - 1),
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex(Math.max(clampedIndex - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (entries[clampedIndex]) executeEntry(entries[clampedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
      }
    },
    [entries, clampedIndex, executeEntry, onClose],
  );

  if (!open) return null;

  const isSearching = debounced.length > 0 && taskSearch.isFetching;
  const showEmptyState = !isSearching && entries.length === 0;

  return (
    <div
      className="fixed inset-0 z-[60]"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Command palette"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 supports-backdrop-filter:backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="absolute top-[12%] left-1/2 -translate-x-1/2 w-full max-w-xl mx-auto px-4">
        <div className="rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 overflow-hidden">
          {/* Input row */}
          <div className="flex items-center gap-2 px-3 border-b border-border/60">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                selectedTask
                  ? `Search, or act on ${selectedTask.key}…`
                  : "Search tasks, projects… or type a command"
              }
              className="flex-1 h-12 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono text-muted-foreground/60 border border-border/60 rounded px-1 py-0.5 shrink-0">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
            {entries.map((entry, i) => {
              const active = i === clampedIndex;
              const firstOfKind = (pred: (e: Entry) => boolean) =>
                pred(entry) && entries.findIndex(pred) === i;
              const isFirstTask = firstOfKind((e) => e.kind === "task");
              const isFirstProject = firstOfKind((e) => e.kind === "project");
              const isFirstRecent = firstOfKind((e) => e.kind === "recent");
              const isFirstTaskAction = firstOfKind(
                (e) => e.kind === "action" && e.group === "task",
              );
              const isFirstCommand = firstOfKind(
                (e) => e.kind === "action" && e.group === "commands",
              );

              return (
                <div key={entry.id}>
                  {isFirstTask && (
                    <SectionHeader
                      icon={<FileText className="size-3" />}
                      label="Tasks"
                    />
                  )}
                  {isFirstProject && (
                    <SectionHeader
                      icon={<FolderKanban className="size-3" />}
                      label="Projects"
                    />
                  )}
                  {isFirstTaskAction && (
                    <SectionHeader
                      icon={<Terminal className="size-3" />}
                      label={selectedTask ? selectedTask.key : "Task"}
                    />
                  )}
                  {isFirstCommand && (
                    <SectionHeader
                      icon={<Terminal className="size-3" />}
                      label="Commands"
                    />
                  )}
                  {isFirstRecent && (
                    <SectionHeader
                      icon={<Clock className="size-3" />}
                      label="Recent"
                    />
                  )}

                  <button
                    type="button"
                    data-result-index={i}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors cursor-pointer group",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50",
                    )}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={(e) => {
                      e.stopPropagation();
                      executeEntry(entry);
                    }}
                  >
                    {entry.kind === "task" && (
                      <TaskRow task={entry.task} exact={entry.exact} />
                    )}
                    {entry.kind === "recent" && (
                      <RecentRow recent={entry.recent} />
                    )}
                    {entry.kind === "project" && (
                      <ProjectRow project={entry.project} />
                    )}
                    {entry.kind === "action" && (
                      <span className="truncate flex-1">
                        {entry.action.label}
                      </span>
                    )}
                    {active && (
                      <ArrowRight className="size-3.5 text-muted-foreground/70 shrink-0" />
                    )}
                  </button>
                </div>
              );
            })}

            {isSearching && (
              <div className="px-3 py-2 text-[12px] text-muted-foreground">
                Searching…
              </div>
            )}

            {showEmptyState && (
              <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">
                {debounced ? (
                  <>
                    No matches for{" "}
                    <span className="font-medium">{debounced}</span>
                  </>
                ) : (
                  "Type to search tasks and projects"
                )}
              </div>
            )}
          </div>

          {/* Footer hints */}
          <div className="flex items-center gap-3 px-3 h-8 border-t border-border/60 bg-muted/30 text-[11px] text-muted-foreground">
            <Hint keys={["↑", "↓"]} label="navigate" />
            <Hint keys={["↵"]} label="run" />
            <Hint keys={["esc"]} label="close" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
      {icon}
      {label}
    </div>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex items-center justify-center min-w-4 px-1 py-0.5 rounded border border-border/60 bg-muted font-mono text-[10px]"
        >
          {k}
        </kbd>
      ))}
      {label}
    </span>
  );
}

function TaskRow({ task, exact }: { task: Task; exact?: boolean }) {
  return (
    <>
      {task.project_color ? (
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: task.project_color }}
          aria-hidden
        />
      ) : (
        <span className="size-2 rounded-full shrink-0 bg-muted-foreground/30" />
      )}
      <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-16 truncate">
        {task.key}
      </span>
      <span className="truncate flex-1">{task.title}</span>
      {exact && (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
          Exact
        </span>
      )}
      {task.priority && (
        <span
          className={cn(
            "shrink-0 text-[10px] font-medium border rounded px-1.5 py-0.5 font-mono",
            PRIORITY_COLORS[task.priority],
          )}
        >
          {task.priority}
        </span>
      )}
    </>
  );
}

function RecentRow({ recent }: { recent: RecentTask }) {
  return (
    <>
      {recent.project_color ? (
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: recent.project_color }}
          aria-hidden
        />
      ) : (
        <span className="size-2 rounded-full shrink-0 bg-muted-foreground/30" />
      )}
      <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-16 truncate">
        {recent.key}
      </span>
      <span className="truncate flex-1">{recent.title}</span>
      {recent.priority && (
        <span
          className={cn(
            "shrink-0 text-[10px] font-medium border rounded px-1.5 py-0.5 font-mono",
            PRIORITY_COLORS[recent.priority],
          )}
        >
          {recent.priority}
        </span>
      )}
    </>
  );
}

function ProjectRow({ project }: { project: Project }) {
  return (
    <>
      <span
        className="size-2 rounded-full shrink-0"
        style={{ background: project.color ?? "#6366f1" }}
        aria-hidden
      />
      <span className="font-mono text-[11px] text-muted-foreground shrink-0 w-16 truncate">
        {project.prefix}
      </span>
      <span className="truncate flex-1">{project.name}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Task-scoped command builder
// ---------------------------------------------------------------------------

/** Commands for the board's selected task. Handlers do NOT close the palette
 *  themselves — `executeEntry` closes before running, so these only perform
 *  the mutation (+ cache invalidation via the shared `invalidate`). */
function buildTaskActions(
  task: Task,
  projects: Project[],
  users: { id: number; username: string }[],
  labels: Label[],
  invalidate: () => void,
  openTask: (task: Task) => void,
): PaletteAction[] {
  const actions: PaletteAction[] = [];

  actions.push({
    id: "open-task",
    label: `Open ${task.key}`,
    keywords: "open show edit task",
    handler: () => openTask(task),
  });

  actions.push({
    id: "copy-task-id",
    label: `Copy task ID — ${task.key}`,
    keywords: "copy id key clipboard",
    handler: () => void copyTaskId(task),
  });
  actions.push({
    id: "copy-task-prompt",
    label: "Copy prompt for Claude",
    keywords: "copy prompt claude context clipboard",
    handler: () => void copyTaskPrompt(task),
  });

  // Move to → column
  const taskProject = projects.find((p) => p.id === task.project);
  const availableColumns = taskProject
    ? taskProject.columns.slice().sort((a, b) => a.order - b.order)
    : [];
  for (const col of availableColumns) {
    if (col.id === task.column?.id) continue;
    actions.push({
      id: `move-${col.id}`,
      label: `Move to → ${col.name}`,
      keywords: "move column status",
      handler: async () => {
        await apiFetch(`/api/tasks/${task.key}/move/`, {
          method: "POST",
          body: { column_id: col.id },
        });
        invalidate();
      },
    });
  }

  // Set priority
  for (const p of ["P1", "P2", "P3", "P4"] as const) {
    if (task.priority === p) continue;
    actions.push({
      id: `priority-${p}`,
      label: `Set priority → ${p}`,
      keywords: "priority",
      handler: async () => {
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { priority: p },
        });
        invalidate();
      },
    });
  }
  if (task.priority != null) {
    actions.push({
      id: "priority-clear",
      label: "Clear priority",
      keywords: "priority clear remove none",
      handler: async () => {
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { priority: null },
        });
        invalidate();
      },
    });
  }

  // Assignees — for each user, show "Add" or "Remove" depending on state.
  const currentAssigneeIds = new Set(task.assignees.map((u) => u.id));
  for (const u of users) {
    const isAssigned = currentAssigneeIds.has(u.id);
    actions.push({
      id: `assign-${u.id}`,
      label: isAssigned
        ? `Unassign → ${u.username}`
        : `Add assignee → ${u.username}`,
      keywords: "assign user",
      handler: async () => {
        const next = isAssigned
          ? [...currentAssigneeIds].filter((id) => id !== u.id)
          : [...currentAssigneeIds, u.id];
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { assignee_ids: next },
        });
        invalidate();
      },
    });
  }

  // Add label — only labels that are global or belong to the task's project
  const currentLabelIds = new Set(task.labels.map((l) => l.id));
  const validLabels = labels.filter(
    (l) => !l.project || l.project === task.project,
  );
  for (const l of validLabels) {
    if (currentLabelIds.has(l.id)) continue;
    actions.push({
      id: `label-${l.id}`,
      label: `Add label → ${l.name}`,
      keywords: "label tag",
      handler: async () => {
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { label_ids: [...Array.from(currentLabelIds), l.id] },
        });
        invalidate();
      },
    });
  }

  // Change project — moves to the first column of the target project.
  for (const p of projects) {
    if (p.id === task.project) continue;
    actions.push({
      id: `change-project-${p.id}`,
      label: `Change project → ${p.name}`,
      keywords: "project move",
      handler: async () => {
        const targetCol = p.columns
          .slice()
          .sort((a, b) => a.order - b.order)[0];
        if (!targetCol) return;
        await apiFetch(`/api/tasks/${task.key}/move/`, {
          method: "POST",
          body: { column_id: targetCol.id },
        });
        invalidate();
      },
    });
  }

  return actions;
}
