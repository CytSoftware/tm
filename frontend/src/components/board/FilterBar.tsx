"use client";

/**
 * Filter + sort bar for the board page.
 *
 * - State lives in the board page so navigation between board/list view keeps
 *   the state stable.
 * - Changes to a filter or sort re-issue the server query with new params —
 *   each column's (or the list's) infinite query refetches from offset 0.
 * - Loading a saved view seeds this state via `boardFiltersFromSavedView`;
 *   the user can then refine it freely. We don't mutate the saved view from
 *   here.
 */

import { useMemo } from "react";
import {
  Archive,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Columns3,
  Filter,
  Flag,
  Folder,
  Search,
  Tag,
  UserRound,
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
  /** Show the "archived projects" toggle — only relevant on the all-projects
   *  board, and only when archived projects actually exist. */
  showArchivedToggle?: boolean;
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
  showArchivedToggle,
}: Props) {
  const modified = loadedView ? !filtersMatchSavedView(filters, loadedView) : false;

  function update<K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }

  // Rendered as a fragment so it can live inline inside the BoardHeader row
  // alongside the project selector, view switcher, and action buttons. The
  // applied-filter chips deliberately do NOT live here: the header row is
  // packed, so a flex-1 chips container collapses to zero width on narrow
  // windows. The board mounts <ActiveFilterChips> as its own row under the
  // header instead.
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
        showArchivedToggle={showArchivedToggle}
      />

      {/* Sort popover. Hidden on mobile — the header only has room for the
          filter control there; sorting stays reachable on desktop and via a
          saved view. */}
      <SortPopover sort={filters.sort} onSortChange={(s) => update("sort", s)} />

      {/* Search — inline on desktop; on mobile the shell's ⌘K palette owns
          search, so this would be a duplicate control competing for width. */}
      <div className="relative w-44 max-lg:hidden">
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

      {modified && loadedView && onSaveToView && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px] shrink-0 max-lg:hidden"
          onClick={onSaveToView}
        >
          Save to view
        </Button>
      )}
    </>
  );
}

/** Applied-filter summary — one chip per active filter FIELD (not per value)
 *  so it's obvious what dimension is being filtered, plus "Clear all". Fixed
 *  field order: Project, Priority, Assignee, Label, Column, Archived.
 *  Rendered by the board as its own wrapping row UNDER the header (renders
 *  null with no active filters) — inside the packed header row the chips
 *  would collapse/clip on narrow windows. See TAS-040. */
export function ActiveFilterChips({
  filters,
  onFiltersChange,
  projects,
  users,
  labels,
}: {
  filters: BoardFilters;
  onFiltersChange: (next: BoardFilters) => void;
  projects: Project[];
  users: User[];
  labels: LabelType[];
}) {
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

  if (isEmptyFilters(filters)) return null;

  function update<K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }

  // Some chips (e.g. Assignee, which folds includeUnassigned into one field)
  // clear more than one BoardFilters key at once.
  function updateMany(patch: Partial<BoardFilters>) {
    onFiltersChange({ ...filters, ...patch });
  }

  return (
    <div className="shrink-0 flex items-center flex-wrap gap-1 px-4 py-1.5 border-b border-border/80 bg-background">
      {filters.project != null && (() => {
        const p = projectById.get(filters.project);
        return (
          <FieldChip
            icon={Folder}
            field="Project"
            values={[{ text: p?.name ?? "Unknown project", color: p?.color }]}
            onClear={() => update("project", null)}
          />
        );
      })()}

      {filters.priorities.length > 0 && (
        <FieldChip
          icon={Flag}
          field="Priority"
          values={filters.priorities.map((p) => ({ text: PRIORITY_LABELS[p] }))}
          onClear={() => update("priorities", [])}
        />
      )}

      {/* Unassigned is folded into the Assignee chip's value list so
          clearing the field clears both assigneeIds and includeUnassigned
          in one action. */}
      {(() => {
        const values = filters.assigneeIds
          .map((id) => userById.get(id))
          .filter((u): u is User => u != null)
          .map((u) => ({ text: u.username }));
        if (filters.includeUnassigned) values.push({ text: "Unassigned" });
        if (values.length === 0) return null;
        return (
          <FieldChip
            icon={UserRound}
            field="Assignee"
            values={values}
            onClear={() =>
              updateMany({ assigneeIds: [], includeUnassigned: false })
            }
          />
        );
      })()}

      {(() => {
        const values = filters.labelIds
          .map((id) => labelById.get(id))
          .filter((l): l is LabelType => l != null)
          .map((l) => ({ text: l.name, color: l.color }));
        if (values.length === 0) return null;
        return (
          <FieldChip
            icon={Tag}
            field="Label"
            values={values}
            onClear={() => update("labelIds", [])}
          />
        );
      })()}

      {filters.columnName && (
        <FieldChip
          icon={Columns3}
          field="Column"
          values={[{ text: filters.columnName }]}
          onClear={() => update("columnName", null)}
        />
      )}

      {filters.includeArchived && (
        <FieldChip
          icon={Archive}
          field="Archived"
          values={[{ text: "included" }]}
          onClear={() => update("includeArchived", false)}
        />
      )}

      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-[11px] text-muted-foreground shrink-0"
        onClick={() => onFiltersChange({ ...EMPTY_BOARD_FILTERS })}
      >
        Clear all
      </Button>
    </div>
  );
}

/** One chip per active filter field: icon, muted "Field:" label, up to 3
 *  values (then "+N", full list in the title attr), and a clear-the-field
 *  button. Per-value color dots (project/label) are opt-in via `value.color`
 *  — the chip itself stays in the app's calm muted style rather than being
 *  colored wholesale. */
function FieldChip({
  icon: Icon,
  field,
  values,
  onClear,
}: {
  icon: React.ComponentType<{ className?: string }>;
  field: string;
  values: { text: string; color?: string }[];
  onClear: () => void;
}) {
  const shown = values.slice(0, 3);
  const overflow = values.length - shown.length;
  const fullTitle = values.map((v) => v.text).join(", ");
  return (
    <span
      title={fullTitle}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] border border-border/60 bg-accent/60 text-foreground shrink-0 max-w-[220px]"
    >
      <Icon className="size-3 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground shrink-0">{field}:</span>
      <span className="inline-flex items-center gap-1 truncate">
        {shown.map((v, i) => (
          <span key={i} className="inline-flex items-center gap-1 shrink-0">
            {v.color && (
              <span
                className="size-1.5 rounded-full shrink-0"
                style={{ background: v.color }}
              />
            )}
            {v.text}
            {i < shown.length - 1 && ","}
          </span>
        ))}
        {overflow > 0 && <span className="shrink-0">+{overflow}</span>}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="opacity-70 hover:opacity-100 shrink-0"
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
  showArchivedToggle,
}: {
  filters: BoardFilters;
  onFiltersChange: (next: BoardFilters) => void;
  projects: Project[];
  users: User[];
  labels: LabelType[];
  availableColumns: string[];
  showArchivedToggle?: boolean;
}) {
  const activeCount = countActiveFilters(filters);
  function update<K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-7 text-[12px] shrink-0",
              activeCount > 0 && "border-foreground/30 bg-accent/50",
            )}
          >
            <Filter className="size-3" />
            <span className="max-lg:sr-only">Filter</span>
            {activeCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-foreground/15 text-[10px] font-medium tabular-nums">
                {activeCount}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent
        className="w-[min(20rem,calc(100vw-2rem))] p-0"
        align="start"
      >
        <div className="max-h-[60dvh] overflow-y-auto scrollbar-none p-3 space-y-3">
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

          {showArchivedToggle && (
            <Section label="Archived projects">
              <button
                type="button"
                onClick={() =>
                  update("includeArchived", !filters.includeArchived)
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-colors",
                  filters.includeArchived
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                )}
              >
                {filters.includeArchived
                  ? "Showing archived-project tasks"
                  : "Show archived-project tasks"}
              </button>
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
  // The "position" field is the manual drag-and-drop order — EMPTY_BOARD_FILTERS'
  // default — so treat it as "no sort applied" rather than an active choice.
  const isDefaultSort = entry.field === "position" && entry.dir === "asc";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-7 text-[12px] shrink-0 max-lg:hidden",
              !isDefaultSort && "border-foreground/30 bg-accent/50",
            )}
          >
            {entry.dir === "desc" ? (
              <ArrowDownWideNarrow className="size-3" />
            ) : (
              <ArrowUpWideNarrow className="size-3" />
            )}
            {isDefaultSort ? "Sort" : `Sort: ${SORT_FIELD_LABELS[entry.field]}`}
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
    (f.columnName ? 1 : 0) +
    (f.includeArchived ? 1 : 0)
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
    !f.includeArchived &&
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
    includeArchived: v.include_archived === true,
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
  if (filters.includeArchived) payload.include_archived = true;
  return payload;
}

function filtersMatchSavedView(filters: BoardFilters, view: SavedView): boolean {
  // Convert both to the on-disk shape and stringify for a stable comparison.
  const fromFilters = JSON.stringify(savedViewPayloadFromFilters(filters));
  const fromView = JSON.stringify(view.filters ?? {});
  const sortsEqual = JSON.stringify(filters.sort) === JSON.stringify(view.sort ?? []);
  return fromFilters === fromView && sortsEqual;
}
