"use client";

import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/UserAvatar";
import { TimeInColumn } from "@/components/task/TimeInColumn";
import { PRIORITY_LABELS } from "@/lib/types";
import type { SavedViewSort, SortField, Task } from "@/lib/types";
import { withAlpha } from "@/lib/colors";

/** Table-column keys. Every entry except "labels" is backed by a SortField. */
type TableCol =
  | "key"
  | "title"
  | "column"
  | "priority"
  | "assignee"
  | "labels"
  | "points"
  | "due_at"
  | "updated_at"
  | "staleness";

/** Columns that map directly to a backend SortField. */
const SORTABLE_COLS: Record<
  Exclude<TableCol, "assignee" | "labels" | "column">,
  SortField
> = {
  key: "title", // no backend sort for key; reuse title as the visible fallback
  title: "title",
  priority: "priority",
  points: "story_points",
  due_at: "due_at",
  updated_at: "updated_at",
  staleness: "staleness",
};

type Props = {
  tasks: Task[];
  showProject?: boolean;
  sort: SavedViewSort;
  onSortChange: (sort: SavedViewSort) => void;
  onTaskClick: (task: Task) => void;
  /** Infinite-scroll plumbing. Rows arrive already server-sorted. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
};

export function ListView({
  tasks,
  showProject,
  sort,
  onSortChange,
  onTaskClick,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: Props) {
  const sentinelRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isLoadingMore) {
            onLoadMore();
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore]);

  function toggleSort(col: TableCol) {
    const mapped = SORTABLE_COLS[col as keyof typeof SORTABLE_COLS];
    if (!mapped) return;
    const current = sort[0];
    if (current?.field === mapped) {
      onSortChange([
        { field: mapped, dir: current.dir === "asc" ? "desc" : "asc" },
      ]);
    } else {
      onSortChange([{ field: mapped, dir: "asc" }]);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow className="text-[12px]">
            <SortableHead col="key" sort={sort} onClick={toggleSort}>
              Key
            </SortableHead>
            <SortableHead col="title" sort={sort} onClick={toggleSort}>
              Title
            </SortableHead>
            <SortableHead col="column" sort={sort} onClick={toggleSort}>
              Status
            </SortableHead>
            <SortableHead col="priority" sort={sort} onClick={toggleSort}>
              Priority
            </SortableHead>
            <SortableHead col="assignee" sort={sort} onClick={toggleSort}>
              Assignees
            </SortableHead>
            <SortableHead col="labels" sort={sort} onClick={toggleSort}>
              Labels
            </SortableHead>
            <SortableHead col="points" sort={sort} onClick={toggleSort}>
              Points
            </SortableHead>
            <SortableHead col="due_at" sort={sort} onClick={toggleSort}>
              Due
            </SortableHead>
            <SortableHead col="staleness" sort={sort} onClick={toggleSort}>
              In column
            </SortableHead>
            <SortableHead col="updated_at" sort={sort} onClick={toggleSort}>
              Updated
            </SortableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow
              key={task.id}
              className="cursor-pointer text-[13px]"
              onClick={() => onTaskClick(task)}
            >
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {task.key}
                {showProject && task.project_prefix && (
                  <span className="ml-1 text-[10px] text-muted-foreground/60">
                    {task.project_prefix}
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-[300px] truncate font-medium">
                {task.title}
              </TableCell>
              <TableCell>
                <span className="text-[12px] text-muted-foreground">
                  {task.column?.name ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-[12px] font-mono font-semibold">
                  {task.priority
                    ? PRIORITY_LABELS[task.priority]
                    : <span className="text-muted-foreground/50">—</span>}
                </span>
              </TableCell>
              <TableCell>
                {task.assignees.length > 0 && (
                  <div className="flex items-center -space-x-1.5">
                    {task.assignees.slice(0, 4).map((u) => (
                      <div
                        key={u.id}
                        className="ring-2 ring-background rounded-full"
                        title={u.username}
                      >
                        <UserAvatar
                          username={u.username}
                          avatarUrl={u.avatar_url}
                          size="size-4"
                        />
                      </div>
                    ))}
                    {task.assignees.length > 4 && (
                      <span className="text-[10px] text-muted-foreground ml-2">
                        +{task.assignees.length - 4}
                      </span>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell>
                {task.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {task.labels.map((l) => (
                      <Badge
                        key={l.id}
                        variant="outline"
                        className="text-[9px] h-4 px-1"
                        style={{
                          background: withAlpha(l.color, 0.13),
                          color: l.color,
                          borderColor: withAlpha(l.color, 0.27),
                        }}
                      >
                        {l.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-[12px] font-mono tabular-nums">
                {task.story_points ?? ""}
              </TableCell>
              <TableCell className="text-[12px]">
                {task.due_at
                  ? new Date(task.due_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : ""}
              </TableCell>
              <TableCell className="text-[12px]">
                <TimeInColumn task={task} size="sm" durationOnly />
              </TableCell>
              <TableCell className="text-[12px] text-muted-foreground">
                {new Date(task.updated_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </TableCell>
            </TableRow>
          ))}
          {tasks.length === 0 && !isLoadingMore && (
            <TableRow>
              <TableCell
                colSpan={10}
                className="text-center text-muted-foreground py-8"
              >
                No tasks found.
              </TableCell>
            </TableRow>
          )}
          {hasMore && (
            <TableRow ref={sentinelRef}>
              <TableCell
                colSpan={10}
                className="text-center text-muted-foreground/70 py-3 text-[11px]"
              >
                {isLoadingMore ? "Loading…" : " "}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function SortableHead({
  col,
  sort,
  onClick,
  children,
  className,
}: {
  col: TableCol;
  sort: SavedViewSort;
  onClick: (col: TableCol) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const mapped = SORTABLE_COLS[col as keyof typeof SORTABLE_COLS];
  const isSortable = !!mapped;
  const current = sort[0];
  const isActive = mapped && current?.field === mapped;

  const Icon = !isActive ? (
    <ArrowUpDown className="size-3 text-muted-foreground/50" />
  ) : current.dir === "asc" ? (
    <ArrowUp className="size-3" />
  ) : (
    <ArrowDown className="size-3" />
  );

  return (
    <TableHead className={className}>
      {isSortable ? (
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => onClick(col)}
        >
          {children}
          {Icon}
        </button>
      ) : (
        <span className="flex items-center gap-1">{children}</span>
      )}
    </TableHead>
  );
}
