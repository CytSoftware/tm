"use client";

import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { focusKey } from "@/lib/query-keys";
import type { FocusItem, FocusPeriod } from "@/lib/types";

const FOCUS_URL = "/api/me/focus/";

/** Fetch the current user's full focus list (both buckets, both directions).
 *  Cheap to keep in cache: the list is small and the page sees every item.
 *  Star buttons on cards read from a derived `Set<task_id>` instead of
 *  re-querying. */
export function useFocusQuery() {
  return useQuery<FocusItem[]>({
    queryKey: focusKey(),
    queryFn: () => apiFetch<FocusItem[]>(FOCUS_URL),
  });
}

/** Set of task ids currently in the focus list (either bucket). */
export function useFocusedIds(): Set<number> {
  const { data } = useFocusQuery();
  return useMemo(() => {
    const s = new Set<number>();
    if (data) for (const item of data) s.add(item.task.id);
    return s;
  }, [data]);
}

export function useAddFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { taskKey: string; period?: FocusPeriod }) =>
      apiFetch<FocusItem>(FOCUS_URL, {
        method: "POST",
        body: { task_key: args.taskKey, period: args.period ?? "week" },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: focusKey() }),
  });
}

export function useRemoveFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskKey: string) =>
      apiFetch<void>(`${FOCUS_URL}${encodeURIComponent(taskKey)}/`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: focusKey() }),
  });
}

type UpdateArgs = {
  taskKey: string;
  period?: FocusPeriod;
  position?: number;
  before_id?: number | null;
  after_id?: number | null;
};

export function useUpdateFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, ...payload }: UpdateArgs) =>
      apiFetch<FocusItem>(`${FOCUS_URL}${encodeURIComponent(taskKey)}/`, {
        method: "PATCH",
        body: payload,
      }),
    // Optimistic period swap — the focus page renders two columns from the
    // same query; flipping `period` locally lets the dragged card land in
    // the destination bucket on the next frame instead of after a round-trip.
    onMutate: async ({ taskKey, period, position }) => {
      await qc.cancelQueries({ queryKey: focusKey() });
      const previous = qc.getQueryData<FocusItem[]>(focusKey());
      if (previous && (period !== undefined || position !== undefined)) {
        qc.setQueryData<FocusItem[]>(
          focusKey(),
          previous.map((item) =>
            item.task.key === taskKey
              ? {
                  ...item,
                  period: period ?? item.period,
                  position: position ?? item.position,
                }
              : item,
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(focusKey(), ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: focusKey() }),
  });
}
