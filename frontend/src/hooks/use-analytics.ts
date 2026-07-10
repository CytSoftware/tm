"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { throughputKey, weeklyCompletionsKey } from "@/lib/query-keys";
import type {
  ThroughputDay,
  ThroughputResponse,
  WeeklyCompletionsResponse,
} from "@/lib/types";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-calendar ISO date (`YYYY-MM-DD`) — avoids the UTC-shift that
 *  `date.toISOString().slice(0, 10)` would introduce for users west of UTC. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return isoDate(dt);
}

/** Monday of the local week containing `d` (ISO week start). */
export function mondayOf(d: Date = new Date()): string {
  const day = d.getDay(); // 0 = Sun .. 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return isoDate(monday);
}

export function currentWeekStart(): string {
  return mondayOf(new Date());
}

export function addWeeksIso(iso: string, deltaWeeks: number): string {
  return addDaysIso(iso, deltaWeeks * 7);
}

export function isCurrentWeek(weekStart: string): boolean {
  return weekStart === currentWeekStart();
}

export type ThroughputRange = 7 | 30 | 90;

type UseThroughputArgs = {
  projectId: number | null;
  days: ThroughputRange;
  enabled?: boolean;
};

/** Fetch the visible flow window and the equally-sized prior comparison in
 * one request. The backend zero-fills both windows. */
export function useThroughputQuery({
  projectId,
  days,
  enabled = true,
}: UseThroughputArgs) {
  const { from, to, tz } = useMemo(() => {
    const today = isoDate(new Date());
    return {
      to: today,
      from: addDaysIso(today, -(days * 2 - 1)),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
  }, [days]);

  const query = useQuery({
    queryKey: throughputKey(projectId, from, to, tz),
    queryFn: () =>
      apiFetch<ThroughputResponse>("/api/analytics/throughput/", {
        query: { project: projectId ?? undefined, from, to, tz },
      }),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const allDays: ThroughputDay[] = query.data?.days ?? [];
  const current = allDays.slice(Math.max(0, allDays.length - days));
  const previous = allDays.slice(
    Math.max(0, allDays.length - days * 2),
    Math.max(0, allDays.length - days),
  );

  return { ...query, current, previous };
}

/** "Jul 6 – Jul 12" (or "Jul 6 – Aug 2" across a month boundary), local. */
export function formatWeekRange(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(`${addDaysIso(weekStart, 6)}T00:00:00`);
  const startLabel = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const endLabel = end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${startLabel} – ${endLabel}`;
}

export function formatWeekShort(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const DEFAULT_TREND_WEEKS = 8;

type UseWeeklyCompletionsArgs = {
  /** Null = all projects (the `project` query param is omitted). */
  projectId: number | null;
  /** Monday of the desired week; null = the server's current week. */
  weekStart: string | null;
  /** How many trailing weeks the trend strip should carry. */
  weeks?: number;
  enabled?: boolean;
};

/**
 * `GET /api/analytics/completions/` — the selected week's total + per-person
 * breakdown, plus a zero-filled trend of the trailing `weeks` weeks. See the
 * frozen contract in the analytics-redesign task description; `week_start`/
 * `week_end` in the response are the source of truth for range labels once
 * loaded, but callers may need a label before the first response lands
 * (`formatWeekRange` computes the same range locally).
 */
export function useWeeklyCompletionsQuery({
  projectId,
  weekStart,
  weeks = DEFAULT_TREND_WEEKS,
  enabled = true,
}: UseWeeklyCompletionsArgs) {
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  return useQuery({
    queryKey: weeklyCompletionsKey(projectId, weekStart ?? "current", weeks, tz),
    queryFn: () =>
      apiFetch<WeeklyCompletionsResponse>("/api/analytics/completions/", {
        query: {
          project: projectId ?? undefined,
          week: weekStart ?? undefined,
          weeks,
          tz,
        },
      }),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
