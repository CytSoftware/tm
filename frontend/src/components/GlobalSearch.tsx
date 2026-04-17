"use client";

/**
 * Global search — Linear-style command-K overlay.
 *
 * Scope: tasks (by key + title + description) and projects (client-filtered
 * from cache). Mounted once at the shell level so Cmd/Ctrl+K works from any
 * page. Opening a result routes through <TaskDialogProvider> so the task
 * panel drops in without navigation.
 *
 * Keyboard:
 *   ↑ / ↓         navigate
 *   Enter         open result
 *   Esc           close
 *   Cmd/Ctrl+K    toggle (registered in the Shell)
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Clock,
  FileText,
  FolderKanban,
  Search,
} from "lucide-react";

import { apiFetch } from "@/lib/api";
import { useActiveProject } from "@/lib/active-project";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useTaskDialog } from "@/lib/task-dialog";
import { useRecentTasks, type RecentTask } from "@/lib/recent-tasks";
import type {
  Priority,
  Project,
  Task,
  TaskListResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
};

type ResultItem =
  | {
      kind: "task";
      id: string;
      task: Task;
      exact?: boolean;
    }
  | {
      kind: "recent";
      id: string;
      recent: RecentTask;
    }
  | {
      kind: "project";
      id: string;
      project: Project;
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

export function GlobalSearch({ open, onClose }: Props) {
  const router = useRouter();
  const { setProjectId, setViewId } = useActiveProject();
  const { openTask, openTaskByKey } = useTaskDialog();

  const projectsQuery = useProjectsQuery();
  const allProjects: Project[] = useMemo(
    () => (projectsQuery.data?.results ?? []).filter((p) => !p.archived),
    [projectsQuery.data],
  );

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recentTasks = useRecentTasks();

  // Reset on open/close
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebounced("");
    setActiveIndex(0);
    // Next tick so the input exists
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

  const items = useMemo<ResultItem[]>(() => {
    // Empty state — show recent tasks as jump-targets
    if (!debounced) {
      return recentTasks.map((r) => ({
        kind: "recent" as const,
        id: `recent-${r.id}`,
        recent: r,
      }));
    }

    const tasks = taskSearch.data?.results ?? [];

    // Exact key match bubbles to the top. Normalise both sides uppercase
    // so the user doesn't have to hold shift.
    const qUpper = debounced.toUpperCase();
    const isKeyLike = TASK_KEY_REGEX.test(debounced);
    const exactTask = isKeyLike
      ? tasks.find((t) => t.key.toUpperCase() === qUpper)
      : undefined;
    const rest = exactTask
      ? tasks.filter((t) => t.id !== exactTask.id)
      : tasks;

    const out: ResultItem[] = [];
    if (exactTask) {
      out.push({
        kind: "task",
        id: `task-${exactTask.id}`,
        task: exactTask,
        exact: true,
      });
    }
    for (const t of rest) {
      out.push({ kind: "task", id: `task-${t.id}`, task: t });
    }
    for (const p of filteredProjects) {
      out.push({ kind: "project", id: `project-${p.id}`, project: p });
    }
    return out;
  }, [debounced, taskSearch.data, filteredProjects, recentTasks]);

  // Clamp active index when items change
  useEffect(() => {
    setActiveIndex((i) => {
      if (items.length === 0) return 0;
      return Math.min(i, items.length - 1);
    });
  }, [items.length]);

  // Scroll the active row into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-result-index="${activeIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const executeItem = useCallback(
    (item: ResultItem) => {
      onClose();
      if (item.kind === "task") {
        openTask(item.task);
      } else if (item.kind === "recent") {
        // The cached snapshot may be stale — refetch by key so labels,
        // description, etc. reflect the current state.
        void openTaskByKey(item.recent.key);
      } else if (item.kind === "project") {
        setProjectId(item.project.id);
        setViewId(null);
        router.push("/board");
      }
    },
    [onClose, openTask, openTaskByKey, setProjectId, setViewId, router],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) =>
            items.length === 0 ? 0 : Math.min(i + 1, items.length - 1),
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (items[activeIndex]) executeItem(items[activeIndex]);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
      }
    },
    [items, activeIndex, executeItem, onClose],
  );

  if (!open) return null;

  const isSearching = debounced.length > 0 && taskSearch.isFetching;
  const hasQuery = debounced.length > 0;
  const showRecentHeader = !hasQuery && items.length > 0;
  const showEmptyState =
    hasQuery && !taskSearch.isFetching && items.length === 0;
  const showEmptyRecent = !hasQuery && items.length === 0;

  return (
    <div
      className="fixed inset-0 z-[60]"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Global search"
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
              placeholder="Search tasks, projects… or jump to CYT-123"
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
            {showRecentHeader && (
              <SectionHeader icon={<Clock className="size-3" />} label="Recent" />
            )}

            {items.map((item, i) => {
              const active = i === activeIndex;
              const isFirstTask =
                hasQuery &&
                item.kind === "task" &&
                items.findIndex((it) => it.kind === "task") === i;
              const isFirstProject =
                hasQuery &&
                item.kind === "project" &&
                items.findIndex((it) => it.kind === "project") === i;

              return (
                <div key={item.id}>
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
                      executeItem(item);
                    }}
                  >
                    {item.kind === "task" && (
                      <TaskRow task={item.task} exact={item.exact} />
                    )}
                    {item.kind === "recent" && (
                      <RecentRow recent={item.recent} />
                    )}
                    {item.kind === "project" && (
                      <ProjectRow project={item.project} />
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
                No matches for <span className="font-medium">{debounced}</span>
              </div>
            )}

            {showEmptyRecent && (
              <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">
                Type to search tasks and projects
              </div>
            )}
          </div>

          {/* Footer hints */}
          <div className="flex items-center gap-3 px-3 h-8 border-t border-border/60 bg-muted/30 text-[11px] text-muted-foreground">
            <Hint keys={["↑", "↓"]} label="navigate" />
            <Hint keys={["↵"]} label="open" />
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
        style={{ background: project.color }}
        aria-hidden
      />
      {project.icon && (
        <span className="text-[13px] leading-none shrink-0">
          {project.icon}
        </span>
      )}
      <span className="truncate flex-1">{project.name}</span>
      <span className="font-mono text-[11px] text-muted-foreground shrink-0">
        {project.prefix}
      </span>
    </>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 font-mono text-[10px] border border-border/60 rounded bg-background/80"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}
