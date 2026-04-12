"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  Task,
  Project,
  User,
  Label,
  SavedView,
  Priority,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaletteAction = {
  id: string;
  label: string;
  /** Additional keywords for fuzzy matching */
  keywords?: string;
  handler: () => void;
};

type Props = {
  selectedTask: Task | null;
  project: Project | undefined;
  projects: Project[];
  users: User[];
  labels: Label[];
  views: SavedView[];
  onClose: () => void;
  /** Callbacks the board page supplies */
  onEditTask: (task: Task) => void;
  onCreateTask: () => void;
  onCreateProject: () => void;
  onCreateLabel: () => void;
  onSwitchProject: (id: number | null) => void;
  onSwitchView: (id: number | null) => void;
};

// ---------------------------------------------------------------------------
// Fuzzy match — every whitespace-separated word in query must appear
// somewhere in the target (case-insensitive).
// ---------------------------------------------------------------------------
function fuzzyMatch(query: string, target: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = target.toLowerCase();
  return words.every((w) => lower.includes(w));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
  selectedTask,
  project,
  projects,
  users,
  labels,
  views,
  onClose,
  onEditTask,
  onCreateTask,
  onCreateProject,
  onCreateLabel,
  onSwitchProject,
  onSwitchView,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Focus the input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Helper: invalidate after mutations
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  }, [queryClient]);

  // Build actions list
  const actions: PaletteAction[] = useMemo(() => {
    if (selectedTask) {
      return buildTaskActions(
        selectedTask,
        project,
        projects,
        users,
        labels,
        invalidate,
        onEditTask,
        onClose,
      );
    }
    return buildGlobalActions(
      projects,
      views,
      onCreateTask,
      onCreateProject,
      onCreateLabel,
      onSwitchProject,
      onSwitchView,
      onClose,
    );
  }, [
    selectedTask,
    project,
    projects,
    users,
    labels,
    views,
    invalidate,
    onEditTask,
    onCreateTask,
    onCreateProject,
    onCreateLabel,
    onSwitchProject,
    onSwitchView,
    onClose,
  ]);

  // Filter by query
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    return actions.filter((a) => fuzzyMatch(query, a.label + " " + (a.keywords ?? "")));
  }, [actions, query]);

  // Clamp active index when filtered list changes
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length, query]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Execute action
  const execute = useCallback(
    (action: PaletteAction) => {
      action.handler();
    },
    [],
  );

  // Keyboard navigation within the palette
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (filtered[activeIndex]) {
            execute(filtered[activeIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
      }
    },
    [filtered, activeIndex, execute, onClose],
  );

  return (
    <div className="fixed inset-0 z-50" onKeyDown={handleKeyDown}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 supports-backdrop-filter:backdrop-blur-xs"
        onClick={onClose}
      />

      {/* Palette */}
      <div className="absolute top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg mx-auto">
        <div className="rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 border-b border-border/60">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                selectedTask
                  ? `Actions for ${selectedTask.key}...`
                  : "Type a command..."
              }
              className="flex-1 h-11 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono text-muted-foreground/60 border border-border/60 rounded px-1 py-0.5">
              ESC
            </kbd>
          </div>

          {/* Action list */}
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching actions
              </div>
            ) : (
              filtered.map((action, i) => (
                <button
                  key={action.id}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors cursor-pointer",
                    i === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/50",
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={(e) => {
                    e.stopPropagation();
                    execute(action);
                  }}
                >
                  <span className="truncate">{action.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action builders
// ---------------------------------------------------------------------------

const COLUMNS = ["Backlog", "Todo", "In Progress", "In Review", "Done"];
const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
  { value: "P3", label: "P3" },
  { value: "P4", label: "P4" },
];

function buildTaskActions(
  task: Task,
  project: Project | undefined,
  projects: Project[],
  users: User[],
  labels: Label[],
  invalidate: () => void,
  onEditTask: (task: Task) => void,
  onClose: () => void,
): PaletteAction[] {
  const actions: PaletteAction[] = [];

  // Determine columns available for the task's project
  const taskProject = projects.find((p) => p.id === task.project);
  const availableColumns = taskProject
    ? taskProject.columns.slice().sort((a, b) => a.order - b.order)
    : [];

  // Move to → column
  for (const col of availableColumns) {
    if (col.id === task.column?.id) continue; // skip current column
    actions.push({
      id: `move-${col.id}`,
      label: `Move to \u2192 ${col.name}`,
      keywords: "move column status",
      handler: async () => {
        onClose();
        await apiFetch(`/api/tasks/${task.key}/move/`, {
          method: "POST",
          body: { column_id: col.id },
        });
        invalidate();
      },
    });
  }

  // Set priority
  for (const p of PRIORITIES) {
    if (task.priority === p.value) continue;
    actions.push({
      id: `priority-${p.value}`,
      label: `Set priority \u2192 ${p.label}`,
      keywords: "priority",
      handler: async () => {
        onClose();
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { priority: p.value },
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
        onClose();
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
        ? `Unassign \u2192 ${u.username}`
        : `Add assignee \u2192 ${u.username}`,
      keywords: "assign user",
      handler: async () => {
        onClose();
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

  // Add label — only show labels that are global or belong to the task's project
  const currentLabelIds = new Set(task.labels.map((l) => l.id));
  const validLabels = labels.filter(
    (l) => !l.project || l.project === task.project,
  );
  for (const l of validLabels) {
    if (currentLabelIds.has(l.id)) continue;
    actions.push({
      id: `label-${l.id}`,
      label: `Add label \u2192 ${l.name}`,
      keywords: "label tag",
      handler: async () => {
        onClose();
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { label_ids: [...Array.from(currentLabelIds), l.id] },
        });
        invalidate();
      },
    });
  }

  // Change project
  for (const p of projects) {
    if (p.id === task.project) continue;
    actions.push({
      id: `change-project-${p.id}`,
      label: `Change project \u2192 ${p.name}`,
      keywords: "project move",
      handler: async () => {
        onClose();
        // Move to first column of the target project
        const targetCol = p.columns
          .slice()
          .sort((a, b) => a.order - b.order)[0];
        if (targetCol) {
          await apiFetch(`/api/tasks/${task.key}/move/`, {
            method: "POST",
            body: { column_id: targetCol.id },
          });
          invalidate();
        }
      },
    });
  }

  // Set story points
  for (const pts of [1, 2, 3, 5, 8, 13, 21]) {
    if (task.story_points === pts) continue;
    actions.push({
      id: `points-${pts}`,
      label: `Set points \u2192 ${pts}`,
      keywords: "story points estimate",
      handler: async () => {
        onClose();
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { story_points: pts },
        });
        invalidate();
      },
    });
  }

  // Set deadline
  const deadlineOptions = [
    { label: "Today", days: 0 },
    { label: "Tomorrow", days: 1 },
    { label: "In 3 days", days: 3 },
    { label: "In 1 week", days: 7 },
    { label: "In 2 weeks", days: 14 },
    { label: "In 1 month", days: 30 },
    { label: "No deadline", days: -1 },
  ];
  for (const opt of deadlineOptions) {
    actions.push({
      id: `deadline-${opt.days}`,
      label: `Set deadline \u2192 ${opt.label}`,
      keywords: "deadline due date",
      handler: async () => {
        onClose();
        const due_at =
          opt.days === -1
            ? null
            : new Date(
                Date.now() + opt.days * 24 * 60 * 60 * 1000,
              ).toISOString();
        await apiFetch(`/api/tasks/${task.key}/`, {
          method: "PATCH",
          body: { due_at },
        });
        invalidate();
      },
    });
  }

  // Edit task
  actions.push({
    id: "edit",
    label: "Edit task",
    keywords: "edit open detail",
    handler: () => {
      onClose();
      onEditTask(task);
    },
  });

  // Delete task
  actions.push({
    id: "delete",
    label: "Delete task",
    keywords: "delete remove",
    handler: async () => {
      onClose();
      await apiFetch(`/api/tasks/${task.key}/`, { method: "DELETE" });
      invalidate();
    },
  });

  return actions;
}

function buildGlobalActions(
  projects: Project[],
  views: SavedView[],
  onCreateTask: () => void,
  onCreateProject: () => void,
  onCreateLabel: () => void,
  onSwitchProject: (id: number | null) => void,
  onSwitchView: (id: number | null) => void,
  onClose: () => void,
): PaletteAction[] {
  const actions: PaletteAction[] = [];

  actions.push({
    id: "create-task",
    label: "Create task",
    keywords: "new add task",
    handler: () => {
      onClose();
      onCreateTask();
    },
  });

  actions.push({
    id: "create-project",
    label: "Create project",
    keywords: "new add project",
    handler: () => {
      onClose();
      onCreateProject();
    },
  });

  actions.push({
    id: "create-label",
    label: "Create label",
    keywords: "new add label tag",
    handler: () => {
      onClose();
      onCreateLabel();
    },
  });

  // Switch project
  actions.push({
    id: "switch-project-all",
    label: "Switch project \u2192 All projects",
    keywords: "switch project all",
    handler: () => {
      onClose();
      onSwitchProject(null);
    },
  });
  for (const p of projects) {
    actions.push({
      id: `switch-project-${p.id}`,
      label: `Switch project \u2192 ${p.name}`,
      keywords: "switch project",
      handler: () => {
        onClose();
        onSwitchProject(p.id);
      },
    });
  }

  // Switch view
  for (const v of views) {
    actions.push({
      id: `switch-view-${v.id}`,
      label: `Switch view \u2192 ${v.name}`,
      keywords: "switch view",
      handler: () => {
        onClose();
        onSwitchView(v.id);
      },
    });
  }

  return actions;
}
