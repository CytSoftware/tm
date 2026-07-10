"use client";

/**
 * Weekly completions — hero bar chart, one bar per person for the selected
 * week. Per the dataviz skill's color formula: this is a NOMINAL categorical
 * set (reordering people doesn't change meaning), so every real-person bar
 * takes the same slot-1 accent hue — never a generated per-person palette —
 * and needs no legend box (a single color, the card title already says what
 * it is). "Unassigned" is the one bucket that reads as a distinct, always-
 * last "other" — it gets the de-emphasis gray instead of a second identity
 * color (see `chart-colors.ts`).
 *
 * Each bar is directly labeled with its count at the tip (mark spec: "Bars →
 * value at the tip"), and the person is identified beneath via a custom
 * SVG tick — `<foreignObject>` anchored at Recharts' own computed tick x/y,
 * so the avatar+name always line up with their bar regardless of axis
 * margins, rather than a separate DOM row that would need to reverse-engineer
 * the plot's left/right insets to stay aligned.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import { useTheme } from "next-themes";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { UserAvatar } from "@/components/UserAvatar";
import { CHART_CHROME, COMPLETIONS_ACCENT, COMPLETIONS_MUTED, type ChartChrome } from "@/lib/chart-colors";
import type { CompletionsPerson } from "@/lib/types";
import { describeDelta } from "./DeltaIndicator";

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

type PersonBar = CompletionsPerson & { id: string };

function toBars(perPerson: CompletionsPerson[]): PersonBar[] {
  return perPerson.map((p) => ({
    ...p,
    id: p.user_id != null ? String(p.user_id) : "unassigned",
  }));
}

const TICK_BAND = 54;

function displayName(p: CompletionsPerson): string {
  return p.user_id == null ? "Unassigned" : (p.username ?? "—");
}

type TickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
};

function renderPersonTick(
  { x, y, payload }: TickProps,
  people: Map<string, PersonBar>,
): ReactElement {
  const person = x == null || y == null || !payload ? undefined : people.get(String(payload.value));
  if (x == null || y == null || !person) return <g />;
  const isUnassigned = person.user_id == null;

  return (
    <g transform={`translate(${x},${y})`}>
      <foreignObject x={-28} y={8} width={56} height={TICK_BAND - 8}>
        <div className="flex flex-col items-center gap-1 pt-1 text-center">
          {isUnassigned ? (
            <span className="size-5 rounded-full bg-muted-foreground/25 shrink-0" />
          ) : (
            <UserAvatar
              username={person.username ?? "?"}
              avatarUrl={person.avatar_url ?? undefined}
              size="size-5"
            />
          )}
          <span
            className={
              isUnassigned
                ? "max-w-14 truncate text-[10.5px] italic text-muted-foreground/70"
                : "max-w-14 truncate text-[10.5px] text-muted-foreground"
            }
            title={displayName(person)}
          >
            {displayName(person)}
          </span>
        </div>
      </foreignObject>
    </g>
  );
}

function CompletionsTooltip({
  active,
  payload,
  chrome,
}: {
  active?: boolean;
  payload?: { payload: PersonBar }[];
  chrome: ChartChrome;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const person = payload[0].payload;
  const { direction, diff } = describeDelta(person.count, person.prev_count);
  const deltaLabel =
    direction === "none"
      ? "no prior data"
      : direction === "flat"
        ? "no change vs last week"
        : `${diff > 0 ? "+" : ""}${diff} vs last week`;

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
        className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium"
        style={{ color: chrome.secondaryInk }}
      >
        {person.user_id != null && (
          <UserAvatar
            username={person.username ?? "?"}
            avatarUrl={person.avatar_url ?? undefined}
            size="size-4"
          />
        )}
        {displayName(person)}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-[16px] font-semibold tabular-nums"
          style={{ color: chrome.primaryInk }}
        >
          {person.count}
        </span>
        <span style={{ color: chrome.secondaryInk }}>completed</span>
      </div>
      <div className="mt-0.5 text-[11px]" style={{ color: chrome.mutedInk }}>
        {deltaLabel}
      </div>
    </div>
  );
}

export function CompletionsChart({
  people,
}: {
  people: CompletionsPerson[];
}) {
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";
  const chrome = CHART_CHROME[mode];
  const accent = COMPLETIONS_ACCENT[mode];

  const bars = toBars(people);
  const byId = new Map(bars.map((b) => [b.id, b]));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={bars}
        margin={{ top: 20, right: 12, bottom: 4, left: 0 }}
        barCategoryGap="24%"
      >
        <XAxis
          dataKey="id"
          axisLine={{ stroke: chrome.baseline }}
          tickLine={false}
          height={TICK_BAND}
          interval={0}
          tick={(props: TickProps) => renderPersonTick(props, byId)}
        />
        <YAxis hide domain={[0, "dataMax + 2"]} allowDecimals={false} />
        <Tooltip
          content={<CompletionsTooltip chrome={chrome} />}
          cursor={{ fill: chrome.gridline, opacity: 0.4 }}
        />
        <Bar
          dataKey="count"
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
          isAnimationActive={false}
          activeBar={{ stroke: chrome.surface, strokeWidth: 2 }}
        >
          {bars.map((b) => (
            <Cell
              key={b.id}
              fill={b.user_id == null ? COMPLETIONS_MUTED : accent}
            />
          ))}
          <LabelList
            dataKey="count"
            position="top"
            style={{ fill: chrome.primaryInk, fontSize: 12, fontWeight: 600 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
