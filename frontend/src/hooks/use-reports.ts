"use client";

/** Reports — bot-written HTML pages. Agents publish over MCP; the UI reads
 *  and (staff) deletes. No socket: a new report arrives with a Telegram ping. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { reportKey, reportsListKey } from "@/lib/query-keys";

export type ReportMeta = {
  key: string;
  title: string;
  summary: string;
  project: { id: number; prefix: string; name: string; color: string } | null;
  created_by: string | null;
  created_at: string;
  url: string;
};

export type Report = ReportMeta & { html: string };

export function useReports(search: string) {
  return useQuery({
    queryKey: reportsListKey(search),
    queryFn: () =>
      apiFetch<{ results: ReportMeta[] }>("/api/reports/", {
        query: search ? { q: search } : undefined,
      }),
    select: (page) => page.results,
  });
}

export function useReport(key: string | null) {
  return useQuery({
    queryKey: reportKey(key ?? ""),
    queryFn: () => apiFetch<Report>(`/api/reports/${encodeURIComponent(key ?? "")}/`),
    enabled: !!key,
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch(`/api/reports/${encodeURIComponent(key)}/`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reports"] }),
  });
}
