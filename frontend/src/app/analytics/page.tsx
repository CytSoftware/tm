"use client";

/**
 * /analytics — "how much did we get done this week, per person."
 *
 * v2 replaces the v1 daily 4-line throughput chart + stat tiles (noisy,
 * low-level) with a single high-level weekly view: a week switcher, a big
 * total + delta, a per-person hero bar chart, and a compact trend strip of
 * recent weeks (clicking a week re-scopes everything above it). Header
 * mirrors the old page's project filter; the week switcher follows the same
 * prev/next/"back to now" pattern as `PeriodMasthead` on /bets.
 *
 * Data comes from `useWeeklyCompletionsQuery` against the frozen
 * `GET /api/analytics/completions/` contract — one request per (project,
 * week) pair returns the selected week's totals/per-person breakdown AND a
 * zero-filled trend of the trailing weeks, so the switcher and trend strip
 * never desync.
 */

import { useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Layers,
  RotateCw,
  Undo2,
} from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CompletionsChart } from "@/components/analytics/CompletionsChart";
import { DeltaIndicator } from "@/components/analytics/DeltaIndicator";
import { TrendStrip } from "@/components/analytics/TrendStrip";
import {
  addWeeksIso,
  currentWeekStart,
  formatWeekRange,
  isCurrentWeek,
  useWeeklyCompletionsQuery,
} from "@/hooks/use-analytics";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useActiveProject } from "@/lib/active-project";

const TREND_WEEKS = 8;

export default function AnalyticsPage() {
  const { projectId, setProjectId, hydrated } = useActiveProject();
  const projectsQuery = useProjectsQuery({ includeArchived: false });
  const projects = projectsQuery.data?.results ?? [];

  const [weekStart, setWeekStart] = useState<string>(() => currentWeekStart());

  const completions = useWeeklyCompletionsQuery({
    projectId: hydrated ? projectId : null,
    weekStart,
    weeks: TREND_WEEKS,
    enabled: hydrated,
  });

  const data = completions.data;
  const isWeekEmpty = data != null && data.total === 0;
  const hasTrendData = data?.trend.some((w) => w.total > 0) ?? false;
  const fullyEmpty = isWeekEmpty && !hasTrendData;

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-border/80 bg-background">
        <BarChart3 className="size-4 text-muted-foreground" />
        <h1 className="text-[13px] font-semibold tracking-tight">Analytics</h1>

        <WeekSwitcher weekStart={weekStart} onChange={setWeekStart} />

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
          <SelectTrigger className="ml-auto h-7 w-44 text-[12px]">
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
        <div className="max-w-4xl mx-auto space-y-4">
          {!hydrated || completions.isLoading ? (
            <LoadingSkeleton />
          ) : completions.isError ? (
            <ErrorState onRetry={() => completions.refetch()} />
          ) : !data ? null : fullyEmpty ? (
            <EmptyState />
          ) : (
            <>
              {isWeekEmpty ? (
                <div className="rounded-lg border border-dashed border-border/60 py-8 px-6 text-center text-[12px] text-muted-foreground">
                  Nothing completed this week yet.
                </div>
              ) : (
                <>
                  <TotalsRow total={data.total} prevTotal={data.prev_total} />
                  <div className="rounded-lg border border-border/60 bg-card p-4 h-[360px]">
                    <CompletionsChart people={data.per_person} />
                  </div>
                </>
              )}

              {hasTrendData && (
                <div className="rounded-lg border border-border/60 bg-card p-4">
                  <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Last {TREND_WEEKS} weeks
                  </h2>
                  <div className="h-[110px]">
                    <TrendStrip
                      trend={data.trend}
                      selectedWeekStart={weekStart}
                      onSelectWeek={setWeekStart}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WeekSwitcher({
  weekStart,
  onChange,
}: {
  weekStart: string;
  onChange: (weekStart: string) => void;
}) {
  const atCurrent = isCurrentWeek(weekStart);
  return (
    <div className="ml-1 flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => onChange(addWeeksIso(weekStart, -1))}
        aria-label="Previous week"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="min-w-[126px] text-center text-[12px] font-medium tabular-nums">
        {formatWeekRange(weekStart)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={atCurrent}
        onClick={() => onChange(addWeeksIso(weekStart, 1))}
        aria-label="Next week"
      >
        <ChevronRight className="size-4" />
      </Button>
      {!atCurrent && (
        <button
          type="button"
          onClick={() => onChange(currentWeekStart())}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <Undo2 className="size-3" />
          This week
        </button>
      )}
    </div>
  );
}

function TotalsRow({ total, prevTotal }: { total: number; prevTotal: number }) {
  return (
    <div className="flex items-baseline gap-3 px-1">
      <span className="text-[30px] font-semibold tracking-tight">
        {total.toLocaleString()} done
      </span>
      <DeltaIndicator
        current={total}
        previous={prevTotal}
        suffix="vs last week"
        size="lg"
      />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 w-40 rounded-md bg-muted" />
      <div className="h-[360px] rounded-lg bg-muted" />
      <div className="h-[150px] rounded-lg bg-muted" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-14 mx-auto max-w-md grid place-items-center gap-2 rounded-lg border border-dashed border-border/60 py-14 px-6 text-center">
      <BarChart3 className="size-6 text-muted-foreground/60" />
      <p className="text-[13px] font-medium">Nothing completed this week yet</p>
      <p className="text-[12px] text-muted-foreground">
        Finished tasks will show up here, broken down by who closed them.
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
          The weekly completions data isn&apos;t available right now.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}
