"use client";

/**
 * Daily throughput line chart — four series (created/started/in_review/
 * completed) over the selected range. See the `dataviz` skill: multi-line
 * is the right form for "trend over time" + "tell distinct series apart"
 * combined, one shared count axis (never dual-axis), 2px lines, a legend
 * (mandatory once there's more than one series), and a crosshair tooltip
 * that lists every series at the hovered date rather than requiring the
 * pointer to land on a specific line.
 */

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CHART_CHROME, THROUGHPUT_COLORS, type ChartChrome } from "@/lib/chart-colors";
import {
  THROUGHPUT_METRICS,
  THROUGHPUT_METRIC_LABELS,
  type ThroughputDay,
  type ThroughputMetric,
} from "@/lib/types";

const noopSubscribe = () => () => {};

/** True only once hydrated on the client — `useSyncExternalStore` (rather
 *  than an effect + setState) is the pattern that avoids a same-render
 *  cascading update while still returning `false` for the server-rendered
 *  markup, so the chart never paints the wrong palette for a hydration
 *  frame. */
function useIsMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function useIsDark(): boolean {
  const { resolvedTheme } = useTheme();
  const mounted = useIsMounted();
  return mounted && resolvedTheme === "dark";
}

function formatTickDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTooltipDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

type TooltipPayloadEntry = {
  dataKey?: string | number;
  value?: number;
  color?: string;
};

function CustomTooltip({
  active,
  payload,
  label,
  chrome,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  chrome: ChartChrome;
}) {
  if (!active || !payload || payload.length === 0 || typeof label !== "string") {
    return null;
  }
  return (
    <div
      className="rounded-md border px-2.5 py-2 text-[12px] shadow-md"
      style={{
        background: chrome.surface,
        borderColor: chrome.gridline,
        color: chrome.primaryInk,
      }}
    >
      <div
        className="mb-1.5 text-[11px] font-medium"
        style={{ color: chrome.secondaryInk }}
      >
        {formatTooltipDate(label)}
      </div>
      <div className="space-y-1">
        {THROUGHPUT_METRICS.map((metric) => {
          const entry = payload.find((p) => p.dataKey === metric);
          if (!entry) return null;
          return (
            <div key={metric} className="flex items-center gap-2">
              <span
                className="inline-block h-[2px] w-3 shrink-0 rounded-full"
                style={{ background: entry.color }}
                aria-hidden
              />
              <span
                className="font-semibold tabular-nums"
                style={{ color: chrome.primaryInk }}
              >
                {entry.value ?? 0}
              </span>
              <span style={{ color: chrome.secondaryInk }}>
                {THROUGHPUT_METRIC_LABELS[metric]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ThroughputChart({ data }: { data: ThroughputDay[] }) {
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";
  const chrome = CHART_CHROME[mode];

  // Long ranges (90d) get crowded on the x-axis — thin the ticks so labels
  // never collide instead of shrinking/rotating text.
  const tickInterval = data.length > 45 ? 6 : data.length > 14 ? 2 : 0;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke={chrome.gridline}
          strokeDasharray="0"
        />
        <XAxis
          dataKey="date"
          tickFormatter={formatTickDate}
          interval={tickInterval}
          tick={{ fill: chrome.mutedInk, fontSize: 11 }}
          axisLine={{ stroke: chrome.baseline }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: chrome.mutedInk, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={28}
        />
        <Tooltip
          content={<CustomTooltip chrome={chrome} />}
          cursor={{ stroke: chrome.baseline, strokeWidth: 1 }}
        />
        <Legend
          verticalAlign="top"
          height={28}
          iconType="plainline"
          // Recharts sorts legend items alphabetically by default
          // (itemSorter: "value"); keep the pipeline order the tiles and
          // tooltip use instead.
          itemSorter={(item) =>
            THROUGHPUT_METRICS.indexOf(item.value as ThroughputMetric)
          }
          formatter={(value) => (
            <span style={{ color: chrome.secondaryInk, fontSize: 12 }}>
              {THROUGHPUT_METRIC_LABELS[value as keyof typeof THROUGHPUT_METRIC_LABELS] ?? value}
            </span>
          )}
        />
        {THROUGHPUT_METRICS.map((metric) => (
          <Line
            key={metric}
            type="monotone"
            dataKey={metric}
            name={metric}
            stroke={THROUGHPUT_COLORS[metric][mode]}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: chrome.surface }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
