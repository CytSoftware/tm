"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { betsKey } from "@/lib/query-keys";
import type { Bet, BetMetric, BetStatus, MetricCheckin } from "@/lib/types";

type BetListResponse = { count: number; results: Bet[] };

/** Bets for one project (or `"all"` projects) + one period of the two-month
 *  grid. `period` is an ISO period-start date (see lib/periods.ts) or `"all"`.
 *  Passing `projectId === "all"` omits the project filter so the endpoint
 *  returns every project's bets; `null` disables the query. */
export function useBetsQuery(
  projectId: number | "all" | null,
  period: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: betsKey(projectId, period),
    queryFn: () =>
      apiFetch<BetListResponse>("/api/bets/", {
        query: {
          project: projectId === "all" ? undefined : projectId,
          period: period === "all" ? undefined : period,
        },
      }).then((r) => r.results),
    enabled: (opts?.enabled ?? true) && projectId != null,
  });
}

/** Mutations invalidate the whole ["bets"] namespace, plus task caches when
 *  the change is visible on cards (bet renamed/recolored/deleted). */
function useInvalidateBets(alsoTasks = false) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["bets"] });
    if (alsoTasks) {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["tasks-infinite"] });
    }
  };
}

export type CreateBetPayload = {
  project: number;
  name: string;
  description?: string;
  color?: string;
  status?: BetStatus;
  /** ISO period start; omit for the current period. */
  period_start?: string;
};

export function useCreateBet() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: (payload: CreateBetPayload) =>
      apiFetch<Bet>("/api/bets/", { method: "POST", body: payload }),
    onSuccess: invalidate,
  });
}

export function useUpdateBet() {
  const invalidate = useInvalidateBets(true);
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: Partial<CreateBetPayload> & { id: number }) =>
      apiFetch<Bet>(`/api/bets/${id}/`, { method: "PATCH", body: payload }),
    onSuccess: invalidate,
  });
}

export function useDeleteBet() {
  const invalidate = useInvalidateBets(true);
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/bets/${id}/`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useCreateMetric() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: (payload: {
      bet: number;
      name: string;
      target?: number | null;
      unit?: string;
    }) => apiFetch<BetMetric>("/api/metrics/", { method: "POST", body: payload }),
    onSuccess: invalidate,
  });
}

export function useUpdateMetric() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: number;
      name?: string;
      target?: number | null;
      unit?: string;
    }) =>
      apiFetch<BetMetric>(`/api/metrics/${id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteMetric() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/metrics/${id}/`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useAddCheckin() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: (payload: {
      metric: number;
      value?: number | null;
      note?: string;
    }) =>
      apiFetch<MetricCheckin>("/api/checkins/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateCheckin() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: number;
      value?: number | null;
      note?: string;
    }) =>
      apiFetch<MetricCheckin>(`/api/checkins/${id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteCheckin() {
  const invalidate = useInvalidateBets();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/checkins/${id}/`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}
