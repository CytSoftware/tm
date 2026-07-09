"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { throughputKey } from "@/lib/query-keys";
import type { ThroughputDay, ThroughputResponse } from "@/lib/types";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-calendar ISO date (`YYYY-MM-DD`) — avoids the UTC-shift that
 *  `date.toISOString().slice(0, 10)` would introduce for users west of UTC. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return isoDate(dt);
}

export type ThroughputRange = 7 | 30 | 90;

type UseThroughputArgs = {
  /** Null = all projects (the `project` query param is omitted). */
  projectId: number | null;
  days: ThroughputRange;
};

/**
 * Fetches `2 * days` of daily throughput in a single request — the trailing
 * half is the current window, the leading half is the prior window of equal
 * length, used for the stat-tile deltas. Both slices are always the same
 * length as `days` and zero-filled by the server, so charts/tiles never have
 * to special-case a short window.
 */
export function useThroughputQuery({ projectId, days }: UseThroughputArgs) {
  const { from, to, tz } = useMemo(() => {
    const todayIso = isoDate(new Date());
    return {
      to: todayIso,
      from: addDays(todayIso, -(days * 2 - 1)),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
  }, [days]);

  const query = useQuery({
    queryKey: throughputKey(projectId, from, to, tz),
    queryFn: () =>
      apiFetch<ThroughputResponse>("/api/analytics/throughput/", {
        query: {
          project: projectId ?? undefined,
          from,
          to,
          tz,
        },
      }),
    staleTime: 60_000,
  });

  const allDays: ThroughputDay[] = query.data?.days ?? [];
  // Server returns ascending, zero-filled, `from`..`to` inclusive — exactly
  // `2 * days` rows when it matches the requested range. Guard against a
  // short/empty response (e.g. a 404 during rollout) by slicing from the end
  // so a partial payload still prefers showing the current window.
  const current = allDays.slice(Math.max(0, allDays.length - days));
  const previous = allDays.slice(
    Math.max(0, allDays.length - days * 2),
    Math.max(0, allDays.length - days),
  );

  return { ...query, current, previous, from, to };
}
