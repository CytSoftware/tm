"use client";

/**
 * Weekly completions — trend strip. A compact "emphasis" bar chart per the
 * dataviz skill's `choosing-a-form.md`: every week bar is the same
 * de-emphasis gray except the selected week, which takes the hero chart's
 * accent hue — a highlight-one/gray-the-rest read, not a magnitude ramp.
 * Clicking (or focusing + Enter/Space on) a bar re-scopes the page to that
 * week; the selected tick label also goes bold so selection isn't
 * color-alone.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import { useTheme } from "next-themes";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { formatWeekRange, formatWeekShort } from "@/hooks/use-analytics";
import {
  CHART_CHROME,
  COMPLETIONS_ACCENT,
  COMPLETIONS_MUTED,
  type ChartChrome,
} from "@/lib/chart-colors";
import type { CompletionsTrendWeek } from "@/lib/types";

const noopSubscribe = () => () => {};

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

type TickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
};

function renderWeekTick(
  { x, y, payload }: TickProps,
  selectedWeekStart: string,
  chrome: ChartChrome,
): ReactElement {
  if (x == null || y == null || !payload) return <g />;
  const value = String(payload.value);
  const isSelected = value === selectedWeekStart;
  return (
    <text
      x={x}
      y={Number(y) + 12}
      textAnchor="middle"
      fontSize={10.5}
      fontWeight={isSelected ? 700 : 400}
      fill={isSelected ? chrome.primaryInk : chrome.mutedInk}
    >
      {formatWeekShort(value)}
    </text>
  );
}

function TrendTooltip({
  active,
  payload,
  chrome,
}: {
  active?: boolean;
  payload?: { payload: CompletionsTrendWeek }[];
  chrome: ChartChrome;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const week = payload[0].payload;
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
        className="mb-1 text-[11px] font-medium"
        style={{ color: chrome.secondaryInk }}
      >
        {formatWeekRange(week.week_start)}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-[15px] font-semibold tabular-nums"
          style={{ color: chrome.primaryInk }}
        >
          {week.total}
        </span>
        <span style={{ color: chrome.secondaryInk }}>completed</span>
      </div>
    </div>
  );
}

export function TrendStrip({
  trend,
  selectedWeekStart,
  onSelectWeek,
}: {
  trend: CompletionsTrendWeek[];
  selectedWeekStart: string;
  onSelectWeek: (weekStart: string) => void;
}) {
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";
  const chrome = CHART_CHROME[mode];
  const accent = COMPLETIONS_ACCENT[mode];

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={trend}
        margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
        barCategoryGap="30%"
      >
        <XAxis
          dataKey="week_start"
          axisLine={{ stroke: chrome.baseline }}
          tickLine={false}
          height={24}
          interval={trend.length > 10 ? 1 : 0}
          tick={(props: TickProps) =>
            renderWeekTick(props, selectedWeekStart, chrome)
          }
        />
        <Tooltip
          content={<TrendTooltip chrome={chrome} />}
          cursor={{ fill: chrome.gridline, opacity: 0.4 }}
        />
        <Bar
          dataKey="total"
          radius={[3, 3, 0, 0]}
          maxBarSize={20}
          isAnimationActive={false}
          cursor="pointer"
          onClick={(data: { payload?: CompletionsTrendWeek }) => {
            if (data.payload) onSelectWeek(data.payload.week_start);
          }}
          activeBar={{ stroke: chrome.surface, strokeWidth: 2 }}
        >
          {trend.map((w) => (
            <Cell
              key={w.week_start}
              fill={w.week_start === selectedWeekStart ? accent : COMPLETIONS_MUTED}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
