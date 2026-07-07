"use client";

/**
 * Period masthead — the clock every bet races against. Shows the two-month
 * period label, a countdown line, and a time track with a "today" marker.
 * Used with period navigation on /bets and read-only (showNav={false},
 * always the current period) on the dashboard.
 */

import { ChevronLeft, ChevronRight, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { currentPeriodStart, periodLabel, shiftPeriod } from "@/lib/periods";
import { cn } from "@/lib/utils";

/** Fraction of the period elapsed right now: 0 before it starts, 1 after
 *  it ends, in between otherwise. */
export function elapsedFraction(period: string, now: Date = new Date()): number {
  const start = new Date(`${period}T00:00:00`).getTime();
  const end = new Date(`${shiftPeriod(period, 1)}T00:00:00`).getTime();
  return Math.max(0, Math.min(1, (now.getTime() - start) / (end - start)));
}

/** Countdown line for the period: how alive is this window? */
export function periodStatus(period: string): string {
  const start = new Date(`${period}T00:00:00`);
  const end = new Date(`${shiftPeriod(period, 1)}T00:00:00`);
  const now = new Date();
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (now < start) return `starts ${fmt(start)}`;
  if (now >= end) return `ended ${fmt(new Date(end.getTime() - 86_400_000))}`;
  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

export function PeriodMasthead({
  period,
  onChange,
  showNav = true,
}: {
  period: string;
  /** Required when showNav is true. */
  onChange?: (period: string) => void;
  /** Hide the prev/next chevrons + "back to now" (dashboard use). */
  showNav?: boolean;
}) {
  const isCurrent = period === currentPeriodStart();
  const elapsed = elapsedFraction(period);

  return (
    <div className="mb-5">
      <div className="flex items-center gap-3">
        {showNav && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => onChange?.(shiftPeriod(period, -1))}
            aria-label="Previous period"
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span
              className={cn(
                "text-[17px] font-semibold tracking-tight",
                !isCurrent && "text-amber-600 dark:text-amber-400",
              )}
            >
              {periodLabel(period)}
            </span>
            {showNav && !isCurrent && (
              <button
                type="button"
                onClick={() => onChange?.(currentPeriodStart())}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Undo2 className="size-3" />
                back to now
              </button>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {periodStatus(period)}
            </span>
          </div>
          <div className="relative mt-2 h-[3px] rounded-full bg-border/70">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-foreground/45"
              style={{ width: `${elapsed * 100}%` }}
            />
            {elapsed > 0 && elapsed < 1 && (
              <span
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2 rounded-full bg-foreground ring-2 ring-background"
                style={{ left: `${elapsed * 100}%` }}
                title="Today"
              />
            )}
          </div>
        </div>

        {showNav && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => onChange?.(shiftPeriod(period, 1))}
            aria-label="Next period"
          >
            <ChevronRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
