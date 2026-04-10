"use client";

import { useMemo, useState } from "react";
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
import { PRIORITY_LABELS } from "@/lib/types";
import type { Task } from "@/lib/types";

type SortKey =
  | "key"
  | "title"
  | "column"
  | "priority"
  | "assignee"
  | "labels"
  | "points"
  | "due_at"
  | "updated_at";

type SortState = {
  key: SortKey;
  dir: "asc" | "desc";
};

const PRIORITY_RANK: Record<string, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

type Props = {
  tasks: Task[];
  showProject?: boolean;
  onTaskClick: (task: Task) => void;
};

export function ListView({ tasks, showProject, onTaskClick }: Props) {
  const [sort, setSort] = useState<SortState>({
    key: "updated_at",
    dir: "desc",
  });

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  const sorted = useMemo(() => {
    const arr = [...tasks];
    const mul = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "key":
          cmp = a.key.localeCompare(b.key);
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "column":
          cmp = a.column.name.localeCompare(b.column.name);
          break;
        case "priority":
          cmp =
            (PRIORITY_RANK[a.priority] ?? 99) -
            (PRIORITY_RANK[b.priority] ?? 99);
          break;
        case "assignee":
          cmp = (a.assignee?.username ?? "").localeCompare(
            b.assignee?.username ?? "",
          );
          break;
        case "points":
          cmp = (a.story_points ?? -1) - (b.story_points ?? -1);
          break;
        case "due_at":
          cmp = (a.due_at ?? "").localeCompare(b.due_at ?? "");
          break;
        case "updated_at":
          cmp = a.updated_at.localeCompare(b.updated_at);
          break;
        default:
          break;
      }
      return cmp * mul;
    });
    return arr;
  }, [tasks, sort]);

  function SortIcon({ col }: { col: SortKey }) {
    if (sort.key !== col)
      return <ArrowUpDown className="size-3 text-muted-foreground/50" />;
    return sort.dir === "asc" ? (
      <ArrowUp className="size-3" />
    ) : (
      <ArrowDown className="size-3" />
    );
  }

  function SortableHead({
    col,
    children,
    className,
  }: {
    col: SortKey;
    children: React.ReactNode;
    className?: string;
  }) {
    return (
      <TableHead className={className}>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => toggleSort(col)}
        >
          {children}
          <SortIcon col={col} />
        </button>
      </TableHead>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow className="text-[12px]">
            <SortableHead col="key">Key</SortableHead>
            <SortableHead col="title">Title</SortableHead>
            <SortableHead col="column">Status</SortableHead>
            <SortableHead col="priority">Priority</SortableHead>
            <SortableHead col="assignee">Assignee</SortableHead>
            <TableHead>Labels</TableHead>
            <SortableHead col="points">Points</SortableHead>
            <SortableHead col="due_at">Due</SortableHead>
            <SortableHead col="updated_at">Updated</SortableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((task) => (
            <TableRow
              key={task.id}
              className="cursor-pointer text-[13px]"
              onClick={() => onTaskClick(task)}
            >
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {task.key}
                {showProject && (
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
                  {task.column.name}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-[12px]">
                  {PRIORITY_LABELS[task.priority]}
                </span>
              </TableCell>
              <TableCell>
                {task.assignee && (
                  <div className="flex items-center gap-1.5">
                    <UserAvatar
                      username={task.assignee.username}
                      size="size-4"
                    />
                    <span className="text-[12px] truncate">
                      {task.assignee.username}
                    </span>
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
                          background: `${l.color}22`,
                          color: l.color,
                          borderColor: `${l.color}44`,
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
              <TableCell className="text-[12px] text-muted-foreground">
                {new Date(task.updated_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </TableCell>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={9}
                className="text-center text-muted-foreground py-8"
              >
                No tasks found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
