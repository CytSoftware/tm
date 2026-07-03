"use client";

/**
 * Metric line — title · reading · Log, with a contained bar underneath.
 * One row per metric: fixed-width title column so every bar starts at the
 * same x, bar inline beside the title, reading after it. Metrics without a
 * target skip the bar — just the latest input.
 *
 * With `onOpen` the title/bar are buttons that open the check-in slide-over
 * and a Log button renders (/bets). Without it the row is read-only
 * (dashboard).
 */

import { Button } from "@/components/ui/button";
import type { BetMetric } from "@/lib/types";

import { elapsedFraction } from "./PeriodMasthead";

/** Pace verdict: latest reading vs. where the target says you should be,
 *  given how much of the period has burned. Only meaningful mid-period on
 *  a metric with both a value and a target. */
export function paceOf(
  value: number,
  target: number,
  period: string,
): "ahead" | "behind" | null {
  const f = elapsedFraction(period);
  if (f <= 0 || f >= 1 || target <= 0) return null;
  return value >= target * f ? "ahead" : "behind";
}

/** "10.0" → "10", "12.5" stays "12.5". */
export function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function MetricLine({
  metric,
  color,
  period,
  onOpen,
}: {
  metric: BetMetric;
  color: string;
  period: string;
  onOpen?: () => void;
}) {
  const latest = metric.checkins[0] ?? null;
  const latestValue = latest?.value ?? null;
  const pace =
    latestValue != null && metric.target != null
      ? paceOf(latestValue, metric.target, period)
      : null;

  const barFill = latestValue != null && metric.target != null && (
    <span
      className="block h-full rounded-full transition-[width] duration-300"
      style={{
        width: `${Math.max(0, Math.min(100, (latestValue / metric.target!) * 100))}%`,
        background: color,
      }}
    />
  );

  return (
    <div className="py-3 flex items-center gap-4">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={metric.name}
          className="w-40 shrink-0 truncate text-left text-[12px] font-medium hover:text-foreground/80 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded-sm"
        >
          {metric.name}
        </button>
      ) : (
        <span
          title={metric.name}
          className="w-40 shrink-0 truncate text-left text-[12px] font-medium"
        >
          {metric.name}
        </span>
      )}

      {metric.target != null ? (
        <>
          {/* Constant bar length — every bar starts *and* ends at the same
              x, regardless of how wide the name or the reading is. */}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={`Open ${metric.name} check-in history`}
              className="w-full max-w-[300px] shrink h-1.5 rounded-full bg-muted overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              {barFill}
            </button>
          ) : (
            <span className="block w-full max-w-[300px] shrink h-1.5 rounded-full bg-muted overflow-hidden">
              {barFill}
            </span>
          )}
          <span className="shrink-0 flex items-baseline gap-1.5 whitespace-nowrap">
            {latestValue != null ? (
              <>
                <span className="font-mono text-[14px] font-semibold tabular-nums">
                  {trimNumber(latestValue)}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  of {trimNumber(metric.target)}
                  {metric.unit && ` ${metric.unit}`}
                </span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground/60">
                no check-ins yet
              </span>
            )}
            {pace === "ahead" && (
              <span
                title="Ahead of pace for this period"
                className="text-[10px] font-medium text-green-600 dark:text-green-400"
              >
                ▲
              </span>
            )}
            {pace === "behind" && (
              <span
                title="Behind pace for this period"
                className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
              >
                ▼
              </span>
            )}
          </span>
        </>
      ) : (
        // No target → no bar. The latest input starts where the bars do,
        // keeping one left rhythm down the whole list.
        <span className="min-w-0 truncate">
          {latestValue != null ? (
            <span className="font-mono text-[14px] font-semibold tabular-nums">
              {trimNumber(latestValue)}
              {metric.unit && (
                <span className="ml-1 font-sans text-[11px] font-normal text-muted-foreground">
                  {metric.unit}
                </span>
              )}
            </span>
          ) : latest ? (
            <span className="text-[11px] text-muted-foreground italic">
              “{latest.note}”
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground/60">
              no check-ins yet
            </span>
          )}
        </span>
      )}

      <span className="flex-1" />
      {onOpen && (
        <Button
          size="sm"
          variant="outline"
          className="h-5 px-1.5 text-[10px] shrink-0"
          onClick={onOpen}
        >
          Log
        </Button>
      )}
    </div>
  );
}
