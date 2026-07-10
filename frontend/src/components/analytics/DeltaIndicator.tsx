"use client";

/**
 * Shared "vs last week" delta readout — the totals row on /analytics and the
 * home dashboard's WeekOverview card both compare a signed count against a
 * prior-period baseline. Per the dataviz skill, a directional delta on a
 * business count (more/fewer things completed) isn't a true good/bad status
 * — it stays in muted text + a direction icon rather than reserved
 * status-palette colors (see `color-formula.md` § Status is fixed).
 */

import { Minus, TrendingDown, TrendingUp } from "lucide-react";

import { cn } from "@/lib/utils";

export type DeltaDirection = "up" | "down" | "flat";

export function describeDelta(
  current: number,
  previous: number,
): { direction: DeltaDirection; diff: number } {
  const diff = current - previous;
  return {
    direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
    diff,
  };
}

export function DeltaIndicator({
  current,
  previous,
  suffix,
  size = "sm",
  className,
}: {
  current: number;
  previous: number;
  /** Trailing text, e.g. "vs last week". Omit for a bare badge (tooltip use). */
  suffix?: string;
  size?: "sm" | "lg";
  className?: string;
}) {
  const { direction, diff } = describeDelta(current, previous);
  const textSize = size === "lg" ? "text-[13px]" : "text-[11px]";
  const iconSize = size === "lg" ? "size-3.5" : "size-3";

  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  const label =
    direction === "flat"
      ? `no change${suffix ? ` ${suffix}` : ""}`
      : `${diff > 0 ? "+" : ""}${diff}${suffix ? ` ${suffix}` : ""}`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium tabular-nums text-muted-foreground",
        textSize,
        className,
      )}
    >
      <Icon className={iconSize} />
      {label}
    </span>
  );
}
