"use client";

/**
 * Reports — HTML pages that bots publish over MCP (`publish_report`).
 * Humans only read them; the list loads metadata, the open report loads its
 * body into a sandboxed iframe (see lib/report-document.ts).
 *
 * State lives in the URL: `?r=RPT-042` is the open report (the link the bots
 * send), `?q=` the search.
 */

import { Suspense, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useTheme } from "next-themes";
import { ChartColumn, Search, Trash2, X } from "lucide-react";

import { MasterDetail } from "@/components/layout/MasterDetail";
import { useDeleteReport, useReport, useReports } from "@/hooks/use-reports";
import { useUrlParams, useUrlSearch } from "@/hooks/use-url-params";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import { reportDocument } from "@/lib/report-document";
import { cn } from "@/lib/utils";

export default function ReportsPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const { params, setParams } = useUrlParams();
  const { urlSearch, search, setSearch } = useUrlSearch(params, setParams);
  const selected = params.get("r");
  const list = useReports(urlSearch);
  const reports = list.data ?? [];

  return (
    <MasterDetail
      railWidth="w-80"
      hasSelection={!!selected}
      onBack={() => setParams({ r: null })}
      backLabel="Reports"
      master={
        <>
          <div className="shrink-0 border-b border-border px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <ChartColumn className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="text-[13px] font-medium">Reports</h1>
            </div>
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 focus-within:border-ring">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reports…"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
              />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                  <X className="size-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {list.isLoading ? (
              <p className="p-4 text-[13px] text-muted-foreground">Loading…</p>
            ) : reports.length === 0 ? (
              <p className="p-4 text-[13px] text-muted-foreground">
                {urlSearch ? "No reports match." : "No reports yet. Bots publish them with publish_report."}
              </p>
            ) : (
              reports.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setParams({ r: r.key }, { push: true })}
                  className={cn(
                    "block w-full border-b border-border/60 px-3 py-2.5 text-left hover:bg-accent/50",
                    r.key === selected && "bg-accent",
                  )}
                >
                  <div className="truncate text-[13px] font-medium">{r.title}</div>
                  {r.summary && (
                    <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{r.summary}</div>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                    <span className="tabular-nums">{format(new Date(r.created_at), "d MMM yyyy")}</span>
                    {r.project && (
                      <span className="flex items-center gap-1">
                        <span className="size-1.5 rounded-full" style={{ background: r.project.color }} />
                        {r.project.prefix}
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      }
      detail={
        selected ? (
          <ReportView reportKey={selected} onDeleted={() => setParams({ r: null })} />
        ) : (
          <div className="flex-1 grid place-items-center text-[13px] text-muted-foreground">
            Pick a report.
          </div>
        )
      }
    />
  );
}

function ReportView({ reportKey, onDeleted }: { reportKey: string; onDeleted: () => void }) {
  const report = useReport(reportKey);
  const { resolvedTheme } = useTheme();
  const { data: me } = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const del = useDeleteReport();
  const html = report.data?.html;
  const srcDoc = useMemo(
    () => (html == null ? undefined : reportDocument(html, resolvedTheme === "dark")),
    [html, resolvedTheme],
  );

  if (report.isError)
    return <p className="p-4 text-[13px] text-muted-foreground">Report not found.</p>;
  if (!report.data) return <p className="p-4 text-[13px] text-muted-foreground">Loading…</p>;
  const r = report.data;

  return (
    <>
      <div className="shrink-0 flex items-center gap-2 border-b border-border px-4 min-h-12">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{r.title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {r.key} · {format(new Date(r.created_at), "d MMM yyyy, HH:mm")}
            {r.project && ` · ${r.project.name}`}
            {r.created_by && ` · ${r.created_by}`}
          </div>
        </div>
        {me?.is_staff && (
          <button
            type="button"
            aria-label="Delete report"
            disabled={del.isPending}
            onClick={() => {
              if (confirm(`Delete "${r.title}"? This is permanent.`))
                del.mutate(r.key, { onSuccess: onDeleted });
            }}
            className="tap-target size-7 shrink-0 grid place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {/* No allow-same-origin: the report gets an opaque origin, so it can't
          read the session or touch the app. Popups escape the sandbox so
          links (opened in a new tab via <base target>) behave normally. */}
      <iframe
        key={r.key}
        title={r.title}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        className="flex-1 min-h-0 w-full border-0 bg-background"
      />
    </>
  );
}
