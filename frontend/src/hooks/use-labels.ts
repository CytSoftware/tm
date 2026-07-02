"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Label } from "@/lib/types";

/** All labels across every project (global + project-scoped) — the same
 *  `["labels"]` query key the board's filter bar / command palette use, so
 *  they share one cache entry instead of issuing duplicate requests. */
export function useLabelsQuery() {
  return useQuery({
    queryKey: ["labels"],
    queryFn: () =>
      apiFetch<{ count: number; results: Label[] }>("/api/labels/").then(
        (r) => r.results,
      ),
  });
}
