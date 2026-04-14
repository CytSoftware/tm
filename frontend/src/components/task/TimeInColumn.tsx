/**
 * Small badge that shows how long a task has been in its current column.
 *
 * - Hidden entirely when the task has no column or no ``current_column_since``
 *   (projectless tasks, legacy rows that never transitioned).
 * - Renders a colored dot when ``staleness`` is set — yellow or red — and
 *   leaves the text unstyled otherwise.
 */

import { Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";

type Size = "xs" | "sm";

type Props = {
  task: Task;
  size?: Size;
  /** Truncate the column name away, showing only the duration + dot. */
  durationOnly?: boolean;
  className?: string;
};

export function TimeInColumn({
  task,
  size = "xs",
  durationOnly = false,
  className,
}: Props) {
  if (!task.column || !task.current_column_since) return null;

  const durationLabel = formatDuration(task.current_column_since);
  const staleness = task.staleness;

  const dotColor =
    staleness === "red"
      ? "bg-red-500"
      : staleness === "yellow"
        ? "bg-amber-500"
        : "bg-muted-foreground/30";

  const textColor =
    staleness === "red"
      ? "text-red-600 dark:text-red-400"
      : staleness === "yellow"
        ? "text-amber-600 dark:text-amber-500"
        : "text-muted-foreground";

  const fontSize = size === "sm" ? "text-[11px]" : "text-[10px]";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        fontSize,
        textColor,
        className,
      )}
      title={
        durationOnly
          ? `${durationLabel} in ${task.column.name}`
          : undefined
      }
    >
      <span className={cn("size-1.5 rounded-full shrink-0", dotColor)} />
      {staleness ? null : <Clock className="size-3 shrink-0 opacity-70" />}
      <span>
        {durationLabel}
        {!durationOnly && (
          <span className="text-muted-foreground/70">
            {" "}in {task.column.name}
          </span>
        )}
      </span>
    </span>
  );
}

/** "2h", "3d", "12d", "2w" — compact durations since `iso`. */
export function formatDuration(iso: string, nowMs?: number): string {
  const then = new Date(iso).getTime();
  const now = nowMs ?? Date.now();
  const ms = Math.max(0, now - then);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}
