"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_CHROME,
  THROUGHPUT_COLORS,
  type ChartChrome,
} from "@/lib/chart-colors";
import {
  THROUGHPUT_METRICS,
  THROUGHPUT_METRIC_LABELS,
  type ThroughputDay,
  type ThroughputMetric,
} from "@/lib/types";

const noopSubscribe = () => () => {};

function useIsDark(): boolean {
  const { resolvedTheme } = useTheme();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return mounted && resolvedTheme === "dark";
}

function formatDate(iso: string, weekday = false): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: weekday ? "short" : undefined,
    month: "short",
    day: "numeric",
  });
}

type TooltipEntry = {
  dataKey?: string | number;
  value?: number;
  color?: string;
};

function FlowTooltip({
  active,
  payload,
  label,
  chrome,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  chrome: ChartChrome;
}) {
  if (!active || !payload?.length || typeof label !== "string") return null;

  return (
    <div
      className="rounded-md border px-3 py-2 text-[11px] shadow-md"
      style={{ background: chrome.surface, borderColor: chrome.gridline }}
    >
      <p className="mb-2 font-medium" style={{ color: chrome.secondaryInk }}>
        {formatDate(label, true)}
      </p>
      <div className="space-y-1.5">
        {THROUGHPUT_METRICS.map((metric) => {
          const entry = payload.find((item) => item.dataKey === metric);
          return (
            <div key={metric} className="flex min-w-32 items-center gap-2">
              <span
                className="size-1.5 rounded-full"
                style={{ background: entry?.color }}
                aria-hidden
              />
              <span className="flex-1" style={{ color: chrome.secondaryInk }}>
                {THROUGHPUT_METRIC_LABELS[metric]}
              </span>
              <span
                className="font-semibold tabular-nums"
                style={{ color: chrome.primaryInk }}
              >
                {entry?.value ?? 0}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ThroughputChart({ data }: { data: ThroughputDay[] }) {
  const mode = useIsDark() ? "dark" : "light";
  const chrome = CHART_CHROME[mode];
  const tickInterval = data.length > 45 ? 6 : data.length > 14 ? 2 : 0;

  return (
    <>
      <div className="h-full w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 0, left: -8 }}
          >
            <CartesianGrid vertical={false} stroke={chrome.gridline} />
            <XAxis
              dataKey="date"
              tickFormatter={(value: string) => formatDate(value)}
              interval={tickInterval}
              tick={{ fill: chrome.mutedInk, fontSize: 10.5 }}
              axisLine={{ stroke: chrome.baseline }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: chrome.mutedInk, fontSize: 10.5 }}
              axisLine={false}
              tickLine={false}
              width={32}
            />
            <Tooltip
              content={<FlowTooltip chrome={chrome} />}
              cursor={{ stroke: chrome.baseline, strokeWidth: 1 }}
            />
            {THROUGHPUT_METRICS.map((metric: ThroughputMetric) => (
              <Line
                key={metric}
                type="monotone"
                dataKey={metric}
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
      </div>

      <table className="sr-only">
        <caption>Daily task flow</caption>
        <thead>
          <tr>
            <th>Date</th>
            {THROUGHPUT_METRICS.map((metric) => (
              <th key={metric}>{THROUGHPUT_METRIC_LABELS[metric]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((day) => (
            <tr key={day.date}>
              <th>{formatDate(day.date, true)}</th>
              {THROUGHPUT_METRICS.map((metric) => (
                <td key={metric}>{day[metric]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
