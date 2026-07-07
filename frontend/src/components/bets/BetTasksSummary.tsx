"use client";

/**
 * Linked-task rollup for a bet — "n of m done" with a thin fraction bar,
 * laid out on the same grid as MetricLine so it reads as one more line on
 * the scoreboard. `expandable` (bets page) toggles the embedded task list;
 * the compact form (dashboard) is just the fraction row.
 *
 * The data is already on every bet read: the serializer annotates
 * task_count/done_task_count and embeds compact task refs.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useTaskDialog } from "@/lib/task-dialog";
import { cn } from "@/lib/utils";
import type { Bet } from "@/lib/types";

export function BetTasksSummary({
  bet,
  expandable = false,
}: {
  bet: Bet;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { openTaskByKey } = useTaskDialog();

  if (bet.task_count === 0) {
    // Compact (dashboard) rows just disappear; the bets page keeps a quiet
    // hint so the affordance is discoverable.
    if (!expandable) return null;
    return (
      <div className="py-2 text-[11px] text-muted-foreground/60">
        No linked tasks — link them from the board or task panel.
      </div>
    );
  }

  const fraction = bet.done_task_count / bet.task_count;
  const label = `${bet.done_task_count} of ${bet.task_count} done`;

  return (
    <div>
      <div className="py-3 flex items-center gap-4">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="w-40 shrink-0 flex items-center gap-1 text-left text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded-sm"
          >
            {open ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            Tasks
          </button>
        ) : (
          <span className="w-40 shrink-0 text-[12px] font-medium text-muted-foreground">
            Tasks
          </span>
        )}

        <span className="block w-full max-w-[300px] shrink h-1.5 rounded-full bg-muted overflow-hidden">
          <span
            className="block h-full rounded-full bg-foreground/40 transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, fraction * 100))}%` }}
          />
        </span>

        <span className="shrink-0 flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="font-mono text-[14px] font-semibold tabular-nums">
            {bet.done_task_count}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            of {bet.task_count} done
          </span>
        </span>

        <span className="flex-1" />
      </div>

      {expandable && open && (
        <ul className="pb-2 space-y-0.5" aria-label={label}>
          {bet.tasks.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => void openTaskByKey(t.key)}
                className="w-full flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[12px] hover:bg-accent/50 transition-colors"
              >
                <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                  {t.key}
                </span>
                <span
                  className={cn(
                    "truncate flex-1",
                    t.is_done && "line-through text-muted-foreground",
                  )}
                >
                  {t.title}
                </span>
                {t.column && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/80">
                    {t.column}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
