"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import type { BoardColumnPrefs, Me } from "@/lib/types";

/**
 * Reads + mutates the current user's per-project kanban column visibility
 * (``preferences.board_column_prefs`` on ``/api/auth/me/``). Mirrors the
 * ``assign_hotkey_bindings`` PATCH idiom in AssignDialog.tsx / Sidebar.tsx:
 * the whole map is replaced on every PATCH (the backend has no per-key
 * merge), so we always send the full object back with just the target
 * project's entry updated. Optimistic: the ``meKey()`` cache is patched in
 * ``onMutate`` so the board reacts instantly, rolled back on error, and
 * invalidated on settle to reconcile with the server.
 *
 * ``projectId`` is the real project id, or ``null`` for the all-projects
 * board — which is stored server-side under the string key ``"0"``.
 */
export function useBoardColumnPrefs(projectId: number | null) {
  const qc = useQueryClient();
  const scopeKey = String(projectId ?? 0);

  // Shares the ``meKey()`` cache Shell seeds on boot — same idiom as
  // AssignDialog's ``meQuery``, so this doesn't trigger a second fetch.
  const meQuery = useQuery({
    queryKey: meKey(),
    queryFn: fetchMe,
  });

  const allPrefs: BoardColumnPrefs = useMemo(
    () => meQuery.data?.preferences?.board_column_prefs ?? {},
    [meQuery.data],
  );

  const hiddenColumns = useMemo(
    () => new Set(allPrefs[scopeKey]?.hidden_columns ?? []),
    [allPrefs, scopeKey],
  );

  const mutation = useMutation({
    mutationFn: (nextPrefs: BoardColumnPrefs) =>
      apiFetch<Me>("/api/auth/me/", {
        method: "PATCH",
        body: { preferences: { board_column_prefs: nextPrefs } },
      }),
    onMutate: async (nextPrefs) => {
      await qc.cancelQueries({ queryKey: meKey() });
      const previous = qc.getQueryData<Me | null>(meKey());
      if (previous) {
        qc.setQueryData<Me | null>(meKey(), {
          ...previous,
          preferences: {
            ...previous.preferences,
            board_column_prefs: nextPrefs,
          },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx && ctx.previous !== undefined) {
        qc.setQueryData(meKey(), ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: meKey() });
    },
  });

  function setHidden(columnId: number, hidden: boolean) {
    const current = new Set(allPrefs[scopeKey]?.hidden_columns ?? []);
    if (hidden) current.add(columnId);
    else current.delete(columnId);
    const nextPrefs: BoardColumnPrefs = {
      ...allPrefs,
      [scopeKey]: { hidden_columns: Array.from(current) },
    };
    mutation.mutate(nextPrefs);
  }

  return {
    /** Column ids hidden for the current project scope. */
    hiddenColumns,
    hideColumn: (columnId: number) => setHidden(columnId, true),
    showColumn: (columnId: number) => setHidden(columnId, false),
  };
}
