"use client";

import { formatWeekRange, formatWeekShort } from "@/hooks/use-analytics";
import type { CompletionsTrendWeek } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Recent weeks are explicit buttons so selection works equally with mouse,
 * touch, keyboard, and screen readers. */
export function TrendStrip({
  trend,
  selectedWeekStart,
  onSelectWeek,
}: {
  trend: CompletionsTrendWeek[];
  selectedWeekStart: string;
  onSelectWeek: (weekStart: string) => void;
}) {
  const max = Math.max(1, ...trend.map((week) => week.total));

  return (
    <div
      className="grid h-full w-full min-w-0 grid-flow-col auto-cols-fr gap-1"
      role="group"
      aria-label="Select a recent week"
    >
      {trend.map((week) => {
        const selected = week.week_start === selectedWeekStart;
        const height = `${Math.max(5, (week.total / max) * 100)}%`;

        return (
          <button
            key={week.week_start}
            type="button"
            onClick={() => onSelectWeek(week.week_start)}
            aria-pressed={selected}
            aria-label={`${formatWeekRange(week.week_start)}: ${week.total} completed`}
            className="group flex min-w-0 flex-col rounded-md px-1 pt-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            title={`${formatWeekRange(week.week_start)} · ${week.total} completed`}
          >
            <span className="flex min-h-0 flex-1 items-end justify-center">
              <span
                className={cn(
                  "w-full max-w-6 rounded-t-sm transition-[height,background-color] motion-reduce:transition-none",
                  selected
                    ? "bg-blue-600 dark:bg-blue-500"
                    : "bg-muted-foreground/25 group-hover:bg-muted-foreground/40",
                )}
                style={{ height }}
                aria-hidden
              />
            </span>
            <span
              className={cn(
                "mt-2 truncate text-[9px] tabular-nums sm:text-[10px]",
                selected
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {formatWeekShort(week.week_start)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
