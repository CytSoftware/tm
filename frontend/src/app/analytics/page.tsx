"use client";

/**
 * /analytics — daily task-event throughput.
 *
 * Header mirrors the /bets project switcher: a range control (7/30/90 days)
 * plus an all-projects/single-project select, both scoping everything below
 * them (see the dataviz skill's filter composition rule — one row, above the
 * charts). Data comes from `useThroughputQuery`, which fetches 2x the
 * selected range in one request and slices it into the visible window and
 * the prior window used for the stat-tile deltas.
 *
 * The endpoint may not be deployed yet (`GET /api/analytics/throughput/`
 * 404s) — that surfaces as a quiet inline error state, not a crash.
 */

import { useState } from "react";
import { AlertTriangle, BarChart3, Layers, RotateCw } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { StatTiles } from "@/components/analytics/StatTiles";
import { ThroughputChart } from "@/components/analytics/ThroughputChart";
import { useThroughputQuery, type ThroughputRange } from "@/hooks/use-analytics";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS: ThroughputRange[] = [7, 30, 90];

export default function AnalyticsPage() {
  const { projectId, setProjectId, hydrated } = useActiveProject();
  const projectsQuery = useProjectsQuery({ includeArchived: false });
  const projects = projectsQuery.data?.results ?? [];

  const [range, setRange] = useState<ThroughputRange>(30);

  const throughput = useThroughputQuery({
    projectId: hydrated ? projectId : null,
    days: range,
  });

  const isEmpty =
    throughput.isSuccess &&
    throughput.current.every(
      (d) =>
        d.created === 0 &&
        d.started === 0 &&
        d.in_review === 0 &&
        d.completed === 0,
    );

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-border/80 bg-background">
        <BarChart3 className="size-4 text-muted-foreground" />
        <h1 className="text-[13px] font-semibold tracking-tight">Analytics</h1>

        <RangeControl value={range} onChange={setRange} />

        <Select
          value={projectId != null ? String(projectId) : "all"}
          onValueChange={(v) => setProjectId(v === "all" ? null : Number(v))}
          items={
            {
              all: "All projects",
              ...Object.fromEntries(projects.map((p) => [String(p.id), p.name])),
            } as Record<string, React.ReactNode>
          }
        >
          <SelectTrigger className="h-7 w-44 text-[12px]">
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              <span className="inline-flex items-center gap-2">
                <Layers className="size-3" />
                All projects
              </span>
            </SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                <span className="inline-flex items-center gap-2">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: p.color }}
                  />
                  {p.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40 px-4 py-5">
        <div className="max-w-5xl mx-auto space-y-4">
          {!hydrated || throughput.isLoading ? (
            <LoadingSkeleton />
          ) : throughput.isError ? (
            <ErrorState onRetry={() => throughput.refetch()} />
          ) : isEmpty ? (
            <EmptyState />
          ) : (
            <>
              <StatTiles
                current={throughput.current}
                previous={throughput.previous}
              />
              <div className="rounded-lg border border-border/60 bg-card p-4 h-[420px]">
                <ThroughputChart data={throughput.current} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RangeControl({
  value,
  onChange,
}: {
  value: ThroughputRange;
  onChange: (v: ThroughputRange) => void;
}) {
  return (
    <div
      className="ml-1 flex items-center gap-0.5 rounded-md border border-border/70 p-0.5"
      role="group"
      aria-label="Date range"
    >
      {RANGE_OPTIONS.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={cn(
            "px-2.5 py-1 rounded text-[11px] font-medium tabular-nums transition-colors",
            value === r
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r}d
        </button>
      ))}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[74px] rounded-lg bg-muted" />
        ))}
      </div>
      <div className="h-[420px] rounded-lg bg-muted" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-14 mx-auto max-w-md grid place-items-center gap-2 rounded-lg border border-dashed border-border/60 py-14 px-6 text-center">
      <BarChart3 className="size-6 text-muted-foreground/60" />
      <p className="text-[13px] font-medium">No activity yet</p>
      <p className="text-[12px] text-muted-foreground">
        Nothing was created, started, reviewed, or completed in this window.
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-14 mx-auto max-w-md grid place-items-center gap-3 rounded-lg border border-dashed border-destructive/40 py-14 px-6 text-center">
      <AlertTriangle className="size-6 text-destructive/70" />
      <div className="space-y-1">
        <p className="text-[13px] font-medium">Couldn&apos;t load analytics</p>
        <p className="text-[12px] text-muted-foreground">
          The throughput data isn&apos;t available right now.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}
