"use client";

/**
 * In-memory filter + sort bar for the board page.
 *
 * - State lives in the board page (via `useBoardFilters` below) so navigation
 *   between board/list view keeps the state stable.
 * - Applying a filter is instant — no network round-trip — because the board
 *   already fetches `limit=500` tasks for the active project.
 * - Loading a saved view seeds this state via `boardFiltersFromSavedView`; the
 *   user can then refine it freely. We don't mutate the saved view from here.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Filter,
  Plus,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import { withAlpha } from "@/lib/colors";
import {
  BoardFilters,
  EMPTY_BOARD_FILTERS,
  Label as LabelType,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  Priority,
  Project,
  SavedView,
  SavedViewSort,
  SortField,
  SORT_FIELDS,
  SORT_FIELD_LABELS,
  User,
} from "@/lib/types";

type Props = {
  filters: BoardFilters;
  onFiltersChange: (next: BoardFilters) => void;
  projects: Project[];
  users: User[];
  labels: LabelType[];
  /** Column names available from the current task set (e.g. Backlog/Todo/...). */
  availableColumns: string[];
  /** Saved view currently loaded (if any) — shows "modified" indicator + save affordance. */
  loadedView: SavedView | null;
  /** Called when the user wants to flush current filters back into the loaded view. */
  onSaveToView?: () => void;
};

export function FilterBar({
  filters,
  onFiltersChange,
  projects,
  users,
  labels,
  availableColumns,
  loadedView,
  onSaveToView,
}: Props) {
  const modified = loadedView ? !filtersMatchSavedView(filters, loadedView) : false;
  const hasActiveFilters = !isEmptyFilters(filters);

  function update<K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }

  function clearAll() {
    onFiltersChange({ ...EMPTY_BOARD_FILTERS });
  }

  const userById = useMemo(() => {
    const m = new Map<number, User>();
    users.forEach((u) => m.set(u.id, u));
    return m;
  }, [users]);

  const labelById = useMemo(() => {
    const m = new Map<number, LabelType>();
    labels.forEach((l) => m.set(l.id, l));
    return m;
  }, [labels]);

  const projectById = useMemo(() => {
    const m = new Map<number, Project>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const sortEntry = filters.sort[0];

  // Rendered as a fragment so it can live inline inside the BoardHeader row
  // alongside the project selector, view switcher, and action buttons.
  return (
    <>
      {/* Filter popover */}
      <FilterPopover
        filters={filters}
        onFiltersChange={onFiltersChange}
        projects={projects}
        users={users}
        labels={labels}
        availableColumns={availableColumns}
      />

      {/* Sort popover */}
      <SortPopover sort={filters.sort} onSortChange={(s) => update("sort", s)} />

      {/* Search — inline */}
      <div className="relative w-44">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/70 pointer-events-none" />
        <Input
          value={filters.search}
          onChange={(e) => update("search", e.target.value)}
          placeholder="Search..."
          className="h-7 pl-6 text-[12px]"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => update("search", "")}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
          >
            <X className="size-3 text-muted-foreground" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-none">
        {/* Active filter chips */}
        {filters.project != null && (
          <Chip
            label={projectById.get(filters.project)?.name ?? "Project"}
            color={projectById.get(filters.project)?.color}
            onClear={() => update("project", null)}
          />
        )}
        {filters.priorities.map((p) => (
          <Chip
            key={`pri-${p}`}
            label={PRIORITY_LABELS[p]}
            onClear={() =>
              update(
                "priorities",
                filters.priorities.filter((x) => x !== p),
              )
            }
          />
        ))}
        {filters.includeUnassigned && (
          <Chip
            label="Unassigned"
            onClear={() => update("includeUnassigned", false)}
          />
        )}
        {filters.assigneeIds.map((id) => {
          const u = userById.get(id);
          if (!u) return null;
          return (
            <Chip
              key={`assignee-${id}`}
              label={u.username}
              onClear={() =>
                update(
                  "assigneeIds",
                  filters.assigneeIds.filter((x) => x !== id),
                )
              }
            />
          );
        })}
        {filters.labelIds.map((id) => {
          const l = labelById.get(id);
          if (!l) return null;
          return (
            <Chip
              key={`label-${id}`}
              label={l.name}
              color={l.color}
              onClear={() =>
                update(
                  "labelIds",
                  filters.labelIds.filter((x) => x !== id),
                )
              }
            />
          );
        })}
        {filters.columnName && (
          <Chip
            label={filters.columnName}
            onClear={() => update("columnName", null)}
          />
        )}
      </div>

      {/* Sort indicator (always visible when non-default) */}
      {sortEntry && (
        <span className="text-[11px] text-muted-foreground shrink-0 inline-flex items-center gap-1">
          {sortEntry.dir === "desc" ? (
            <ArrowDownWideNarrow className="size-3" />
          ) : (
            <ArrowUpWideNarrow className="size-3" />
          )}
          {SORT_FIELD_LABELS[sortEntry.field]}
        </span>
      )}

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px] text-muted-foreground shrink-0"
          onClick={clearAll}
        >
          Clear all
        </Button>
      )}

      {modified && loadedView && onSaveToView && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px] shrink-0"
          onClick={onSaveToView}
        >
          Save to view
        </Button>
      )}
    </>
  );
}

function Chip({
  label,
  color,
  onClear,
}: {
  label: string;
  color?: string;
  onClear: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] border shrink-0",
        color ? "font-medium" : "bg-accent/60 text-foreground border-border/60",
      )}
      style={
        color
          ? {
              background: withAlpha(color, 0.14),
              color,
              borderColor: withAlpha(color, 0.35),
            }
          : undefined
      }
    >
      {label}
      <button
        type="button"
        onClick={onClear}
        className="opacity-70 hover:opacity-100"
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

function FilterPopover({
  filters,
  onFiltersChange,
  projects,
  users,
  labels,
  availableColumns,
}: {
  filters: BoardFilters;
  onFiltersChange: (next: BoardFilters) => void;
  projects: Project[];
  users: User[];
  labels: LabelType[];
  availableColumns: string[];
}) {
  const activeCount = countActiveFilters(filters);
  function update<K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 text-[12px] shrink-0">
            <Filter className="size-3" />
            Filter
            {activeCount > 0 && (
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                {activeCount}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent className="w-80 p-0" align="start">
        <div className="max-h-[60vh] overflow-y-auto scrollbar-none p-3 space-y-3">
          <Section label="Priority">
            <div className="flex flex-wrap gap-1">
              {PRIORITY_ORDER.map((p) => {
                const active = filters.priorities.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() =>
                      update(
                        "priorities",
                        active
                          ? filters.priorities.filter((x) => x !== p)
                          : [...filters.priorities, p],
                      )
                    }
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] font-mono font-semibold transition-colors",
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                    )}
                  >
                    {PRIORITY_LABELS[p]}
                  </button>
                );
              })}
            </div>
          </Section>

          {projects.length > 1 && (
            <Section label="Project">
              <div className="flex flex-wrap gap-1">
                {projects.map((p) => {
                  const active = filters.project === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        update("project", active ? null : p.id)
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-colors",
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                      )}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: p.color }}
                      />
                      {p.prefix}
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          <Section label="Assignees">
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() =>
                  update("includeUnassigned", !filters.includeUnassigned)
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                  filters.includeUnassigned
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                )}
              >
                Unassigned
              </button>
              {users.map((u) => {
                const active = filters.assigneeIds.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() =>
                      update(
                        "assigneeIds",
                        active
                          ? filters.assigneeIds.filter((x) => x !== u.id)
                          : [...filters.assigneeIds, u.id],
                      )
                    }
                    className={cn(
                      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                    )}
                  >
                    <UserAvatar
                      username={u.username}
                      avatarUrl={u.avatar_url}
                      size="size-4"
                    />
                    {u.username}
                  </button>
                );
              })}
              {users.length === 0 && (
                <span className="text-[11px] text-muted-foreground">
                  No users.
                </span>
              )}
            </div>
          </Section>

          {labels.length > 0 && (
            <Section label="Labels">
              <div className="flex flex-wrap gap-1">
                {labels.map((l) => {
                  const active = filters.labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() =>
                        update(
                          "labelIds",
                          active
                            ? filters.labelIds.filter((x) => x !== l.id)
                            : [...filters.labelIds, l.id],
                        )
                      }
                      className="rounded border px-1.5 py-0.5 text-[11px] transition-colors"
                      style={{
                        background: active ? withAlpha(l.color, 0.2) : undefined,
                        color: active ? l.color : undefined,
                        borderColor: active ? withAlpha(l.color, 0.4) : undefined,
                      }}
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          {availableColumns.length > 0 && (
            <Section label="Status">
              <div className="flex flex-wrap gap-1">
                {availableColumns.map((name) => {
                  const active = filters.columnName === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() =>
                        update("columnName", active ? null : name)
                      }
                      className={cn(
                        "rounded border px-2 py-0.5 text-[11px] transition-colors",
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                      )}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </Section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SortPopover({
  sort,
  onSortChange,
}: {
  sort: SavedViewSort;
  onSortChange: (next: SavedViewSort) => void;
}) {
  const entry = sort[0] ?? { field: "updated_at", dir: "desc" as const };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 text-[12px] shrink-0">
            {entry.dir === "desc" ? (
              <ArrowDownWideNarrow className="size-3" />
            ) : (
              <ArrowUpWideNarrow className="size-3" />
            )}
            Sort
          </Button>
        }
      />
      <PopoverContent className="w-56 p-2" align="start">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-1 pb-1">
          Sort by
        </div>
        <div className="space-y-0.5">
          {SORT_FIELDS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() =>
                onSortChange([{ field: f, dir: entry.dir }])
              }
              className={cn(
                "w-full text-left rounded px-2 py-1 text-[12px] hover:bg-accent",
                entry.field === f && "bg-accent/60 font-medium",
              )}
            >
              {SORT_FIELD_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="border-t border-border/60 mt-2 pt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-1 pb-1">
            Direction
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() =>
                onSortChange([{ field: entry.field, dir: "asc" }])
              }
              className={cn(
                "flex-1 rounded px-2 py-1 text-[12px] hover:bg-accent inline-flex items-center justify-center gap-1",
                entry.dir === "asc" && "bg-accent/60 font-medium",
              )}
            >
              <ArrowUpWideNarrow className="size-3" /> Asc
            </button>
            <button
              type="button"
              onClick={() =>
                onSortChange([{ field: entry.field, dir: "desc" }])
              }
              className={cn(
                "flex-1 rounded px-2 py-1 text-[12px] hover:bg-accent inline-flex items-center justify-center gap-1",
                entry.dir === "desc" && "bg-accent/60 font-medium",
              )}
            >
              <ArrowDownWideNarrow className="size-3" /> Desc
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers + hooks
// ---------------------------------------------------------------------------

/** Count the number of non-empty filter keys (excluding sort + search). */
function countActiveFilters(f: BoardFilters): number {
  return (
    (f.project != null ? 1 : 0) +
    f.priorities.length +
    f.assigneeIds.length +
    (f.includeUnassigned ? 1 : 0) +
    f.labelIds.length +
    (f.columnName ? 1 : 0)
  );
}

function isEmptyFilters(f: BoardFilters): boolean {
  return (
    f.project == null &&
    f.priorities.length === 0 &&
    f.assigneeIds.length === 0 &&
    !f.includeUnassigned &&
    f.labelIds.length === 0 &&
    !f.columnName &&
    !f.search
  );
}

/** Convert a SavedView into the in-memory BoardFilters shape. */
export function boardFiltersFromSavedView(
  view: SavedView,
  labels: LabelType[],
  users: User[],
): BoardFilters {
  const v = view.filters ?? {};

  // IDs can be stored as numbers, numeric strings, or username/name strings.
  // The sentinel "none" means include unassigned tasks.
  // Resolve to numeric ids the UI expects.
  let includeUnassigned = false;
  const assigneeIds: number[] = [];
  for (const raw of v.assignee ?? []) {
    if (raw === "none") { includeUnassigned = true; continue; }
    if (typeof raw === "number") assigneeIds.push(raw);
    else if (typeof raw === "string") {
      if (/^\d+$/.test(raw)) assigneeIds.push(Number(raw));
      else {
        const match = users.find((u) => u.username === raw);
        if (match) assigneeIds.push(match.id);
      }
    }
  }
  const labelIds: number[] = [];
  for (const raw of v.labels ?? []) {
    if (typeof raw === "number") labelIds.push(raw);
    else if (typeof raw === "string") {
      if (/^\d+$/.test(raw)) labelIds.push(Number(raw));
      else {
        const match = labels.find((l) => l.name === raw);
        if (match) labelIds.push(match.id);
      }
    }
  }
  let project: number | null = null;
  if (typeof v.project === "number") project = v.project;
  else if (typeof v.project === "string" && /^\d+$/.test(v.project))
    project = Number(v.project);

  const columnName =
    typeof v.column === "string"
      ? v.column
      : null;

  return {
    project,
    priorities: (v.priority ?? []) as Priority[],
    assigneeIds,
    includeUnassigned,
    labelIds,
    columnName,
    search: v.search ?? "",
    sort:
      view.sort && view.sort.length > 0
        ? view.sort
        : [{ field: "updated_at", dir: "desc" }],
  };
}

/** Serialize BoardFilters back into the SavedView JSON shape. */
export function savedViewPayloadFromFilters(filters: BoardFilters) {
  const payload: Record<string, unknown> = {};
  if (filters.project != null) payload.project = filters.project;
  if (filters.priorities.length > 0) payload.priority = filters.priorities;
  if (filters.assigneeIds.length > 0 || filters.includeUnassigned) {
    const assignee: (number | string)[] = [];
    if (filters.includeUnassigned) assignee.push("none");
    assignee.push(...filters.assigneeIds);
    payload.assignee = assignee;
  }
  if (filters.labelIds.length > 0) payload.labels = filters.labelIds;
  if (filters.columnName) payload.column = filters.columnName;
  if (filters.search) payload.search = filters.search;
  return payload;
}

function filtersMatchSavedView(filters: BoardFilters, view: SavedView): boolean {
  // Convert both to the on-disk shape and stringify for a stable comparison.
  const fromFilters = JSON.stringify(savedViewPayloadFromFilters(filters));
  const fromView = JSON.stringify(view.filters ?? {});
  const sortsEqual = JSON.stringify(filters.sort) === JSON.stringify(view.sort ?? []);
  return fromFilters === fromView && sortsEqual;
}

/** Filter + sort tasks in memory using the BoardFilters state. */
export function applyBoardFilters(
  tasks: import("@/lib/types").Task[],
  filters: BoardFilters,
): import("@/lib/types").Task[] {
  let result = tasks;
  if (filters.project != null) {
    result = result.filter((t) => t.project === filters.project);
  }
  if (filters.priorities.length > 0) {
    const set = new Set<Priority>(filters.priorities);
    // Tasks with no priority are excluded when a priority filter is active.
    result = result.filter((t) => t.priority != null && set.has(t.priority));
  }
  if (filters.assigneeIds.length > 0 || filters.includeUnassigned) {
    const set = new Set(filters.assigneeIds);
    result = result.filter((t) => {
      if (filters.includeUnassigned && t.assignees.length === 0) return true;
      if (set.size > 0 && t.assignees.some((u) => set.has(u.id))) return true;
      return false;
    });
  }
  if (filters.labelIds.length > 0) {
    const set = new Set(filters.labelIds);
    result = result.filter((t) => t.labels.some((l) => set.has(l.id)));
  }
  if (filters.columnName) {
    result = result.filter((t) => t.column?.name === filters.columnName);
  }
  if (filters.search) {
    // Word-AND matching — every whitespace-separated token must appear in
    // either key or title. Mirrors the backend's `apply_task_filters`
    // behavior so the board search feels consistent with the command palette.
    const words = filters.search.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      result = result.filter((t) => {
        const hay = `${t.key} ${t.title}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
  }
  return applyBoardSort(result, filters.sort);
}

export function applyBoardSort(
  tasks: import("@/lib/types").Task[],
  sort: SavedViewSort,
): import("@/lib/types").Task[] {
  if (!sort || sort.length === 0) return tasks;
  const primary = sort[0];
  const mul = primary.dir === "asc" ? 1 : -1;
  const arr = [...tasks];
  arr.sort((a, b) => {
    let cmp = 0;
    switch (primary.field) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "priority":
        cmp = priorityRank(a.priority) - priorityRank(b.priority);
        break;
      case "story_points":
        cmp = (a.story_points ?? -1) - (b.story_points ?? -1);
        break;
      case "due_at":
        cmp = (a.due_at ?? "").localeCompare(b.due_at ?? "");
        break;
      case "updated_at":
        cmp = a.updated_at.localeCompare(b.updated_at);
        break;
      case "created_at":
        cmp = a.created_at.localeCompare(b.created_at);
        break;
      case "position":
        cmp = a.position - b.position;
        break;
      case "staleness":
        // Oldest current_column_since first = "most stale first" (asc).
        // Null sorts last regardless of direction.
        cmp = stalenessCmp(a, b);
        break;
    }
    return cmp * mul;
  });
  return arr;
}

function stalenessCmp(a: import("@/lib/types").Task, b: import("@/lib/types").Task): number {
  const aTs = a.current_column_since;
  const bTs = b.current_column_since;
  if (aTs == null && bTs == null) return 0;
  if (aTs == null) return 1;
  if (bTs == null) return -1;
  return aTs.localeCompare(bTs);
}

function priorityRank(p: Priority | null): number {
  switch (p) {
    case "P1":
      return 0;
    case "P2":
      return 1;
    case "P3":
      return 2;
    case "P4":
      return 3;
    default:
      // Null priorities sort last regardless of direction.
      return 99;
  }
}
