"use client";

import { Minus, TrendingDown, TrendingUp } from "lucide-react";

import { THROUGHPUT_COLORS } from "@/lib/chart-colors";
import {
  THROUGHPUT_METRICS,
  THROUGHPUT_METRIC_LABELS,
  type ThroughputDay,
  type ThroughputMetric,
} from "@/lib/types";
import { cn } from "@/lib/utils";

function sum(days: ThroughputDay[], metric: ThroughputMetric): number {
  return days.reduce((acc, d) => acc + (d[metric] ?? 0), 0);
}

/** Signed % change, or null when there's no prior-period baseline to
 *  compare against (delta renders muted/"new" in that case per spec). */
function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function StatTiles({
  current,
  previous,
}: {
  current: ThroughputDay[];
  previous: ThroughputDay[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {THROUGHPUT_METRICS.map((metric) => {
        const currentTotal = sum(current, metric);
        const previousTotal = sum(previous, metric);
        const delta = pctDelta(currentTotal, previousTotal);
        return (
          <StatTile
            key={metric}
            metric={metric}
            value={currentTotal}
            delta={delta}
            hasBaseline={previousTotal > 0}
          />
        );
      })}
    </div>
  );
}

function StatTile({
  metric,
  value,
  delta,
  hasBaseline,
}: {
  metric: ThroughputMetric;
  value: number;
  delta: number | null;
  /** False when the previous window's total was 0 — the % is undefined, so
   *  the delta renders as a muted "new" note instead of a number. */
  hasBaseline: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: THROUGHPUT_COLORS[metric].light }}
          aria-hidden
        />
        <span className="text-[11px] font-medium text-muted-foreground">
          {THROUGHPUT_METRIC_LABELS[metric]}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tracking-tight tabular-nums">
          {value.toLocaleString()}
        </span>
        <DeltaBadge delta={delta} hasBaseline={hasBaseline} />
      </div>
    </div>
  );
}

function DeltaBadge({
  delta,
  hasBaseline,
}: {
  delta: number | null;
  hasBaseline: boolean;
}) {
  if (!hasBaseline) {
    return (
      <span className="text-[11px] text-muted-foreground/70">
        {delta === null ? "no prior data" : "new"}
      </span>
    );
  }
  if (delta === null) return null;
  const rounded = Math.round(delta);
  const Icon = rounded > 0 ? TrendingUp : rounded < 0 ? TrendingDown : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums text-muted-foreground",
      )}
    >
      <Icon className="size-3" />
      {rounded === 0 ? "0%" : `${Math.abs(rounded)}%`}
    </span>
  );
}
