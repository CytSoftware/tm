"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Layers,
  RotateCw,
  Undo2,
  Users,
} from "lucide-react";

import { CompletionsChart } from "@/components/analytics/CompletionsChart";
import { DeltaIndicator } from "@/components/analytics/DeltaIndicator";
import { TrendStrip } from "@/components/analytics/TrendStrip";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addWeeksIso,
  currentWeekStart,
  formatWeekRange,
  isCurrentWeek,
  useThroughputQuery,
  useWeeklyCompletionsQuery,
  type ThroughputRange,
} from "@/hooks/use-analytics";
import { useProjectsQuery } from "@/hooks/use-projects";
import { THROUGHPUT_COLORS } from "@/lib/chart-colors";
import { useActiveProject } from "@/lib/active-project";
import {
  THROUGHPUT_METRICS,
  THROUGHPUT_METRIC_LABELS,
  type ThroughputDay,
  type ThroughputMetric,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const ThroughputChart = dynamic(
  () =>
    import("@/components/analytics/ThroughputChart").then(
      (module) => module.ThroughputChart,
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

const TREND_WEEKS = 8;
const RANGE_OPTIONS: ThroughputRange[] = [7, 30, 90];

export default function AnalyticsPage() {
  const { projectId, setProjectId, hydrated } = useActiveProject();
  const projectsQuery = useProjectsQuery({ includeArchived: false });
  const projects = projectsQuery.data?.results ?? [];
  const [weekStart, setWeekStart] = useState(() => currentWeekStart());
  const [range, setRange] = useState<ThroughputRange>(30);

  const completions = useWeeklyCompletionsQuery({
    projectId: hydrated ? projectId : null,
    weekStart,
    weeks: TREND_WEEKS,
    enabled: hydrated,
  });
  const throughput = useThroughputQuery({
    projectId: hydrated ? projectId : null,
    days: range,
    enabled: hydrated,
  });

  const completionData = completions.data;
  const contributors =
    completionData?.per_person.filter(
      (person) => person.user_id != null && person.count > 0,
    ).length ?? 0;
  const selectedCurrentWeek = isCurrentWeek(weekStart);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden [contain:layout_paint]">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border/80 bg-background px-3 py-2 sm:px-4">
        <BarChart3 className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold tracking-tight">Analytics</h1>
        </div>
        <span className="hidden text-[10px] text-muted-foreground md:inline">
          Refreshes every minute
        </span>

        <ProjectSelect
          projectId={projectId}
          projects={projects}
          onChange={setProjectId}
        />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-muted/25 px-3 py-5 sm:px-5 sm:py-6">
        <div className="mx-auto max-w-6xl space-y-9">
          <section className="min-w-0" aria-labelledby="weekly-completions-heading">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Team output
                </p>
                <h2
                  id="weekly-completions-heading"
                  className="mt-1 text-base font-semibold tracking-tight"
                >
                  Weekly completions
                </h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Where finished work landed and how this week compares with the one before it.
                </p>
              </div>
              <WeekSwitcher weekStart={weekStart} onChange={setWeekStart} />
            </div>

            {!hydrated || completions.isLoading ? (
              <WeeklySkeleton />
            ) : completions.isError ? (
              <ErrorState
                message="The weekly completion breakdown isn’t available right now."
                onRetry={() => completions.refetch()}
              />
            ) : completionData ? (
              <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
                <div className="grid min-w-0 lg:grid-cols-[1fr_0.9fr]">
                  <div className="min-w-0 p-5 sm:p-6">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {selectedCurrentWeek ? "Completed this week" : "Completed in selected week"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-4xl font-semibold tracking-[-0.04em] tabular-nums sm:text-[42px]">
                        {completionData.total.toLocaleString()}
                      </span>
                      <span className="text-[12px] text-muted-foreground">tasks</span>
                      <DeltaIndicator
                        current={completionData.total}
                        previous={completionData.prev_total}
                        suffix="vs prior week"
                        size="lg"
                      />
                    </div>

                    <dl className="mt-6 grid grid-cols-2 divide-x divide-border/60 border-t border-border/60 pt-4">
                      <div className="pr-4">
                        <dt className="text-[10px] text-muted-foreground">Prior week</dt>
                        <dd className="mt-1 text-[18px] font-semibold tabular-nums">
                          {completionData.prev_total.toLocaleString()}
                        </dd>
                      </div>
                      <div className="pl-4">
                        <dt className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <Users className="size-3" /> Contributors
                        </dt>
                        <dd className="mt-1 text-[18px] font-semibold tabular-nums">
                          {contributors.toLocaleString()}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="min-w-0 border-t border-border/60 bg-muted/20 p-5 lg:border-l lg:border-t-0 sm:p-6">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-[11px] font-medium">Recent pace</h3>
                        <p className="text-[10px] text-muted-foreground">
                          Select a week to inspect it
                        </p>
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {TREND_WEEKS} weeks
                      </span>
                    </div>
                    <div className="h-28 min-w-0 overflow-hidden pb-1">
                      <TrendStrip
                        trend={completionData.trend}
                        selectedWeekStart={weekStart}
                        onSelectWeek={setWeekStart}
                      />
                    </div>
                  </div>
                </div>

                <div className="border-t border-border/60 px-4 py-5 sm:px-6 sm:py-6">
                  <div className="mb-4 flex items-end justify-between gap-3">
                    <div>
                      <h3 className="text-[12px] font-semibold">Contribution breakdown</h3>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Ranked by completed tasks · comparison is against the prior week
                      </p>
                    </div>
                    {completionData.total > 0 ? (
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">
                        Completed
                      </span>
                    ) : null}
                  </div>

                  {completionData.per_person.length > 0 ? (
                    <CompletionsChart people={completionData.per_person} />
                  ) : (
                    <CompletionEmpty current={selectedCurrentWeek} />
                  )}
                </div>
              </div>
            ) : null}
          </section>

          <section className="min-w-0" aria-labelledby="flow-heading">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Flow health
                </p>
                <h2
                  id="flow-heading"
                  className="mt-1 text-base font-semibold tracking-tight"
                >
                  Work moving through the system
                </h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Daily created, started, reviewed, and completed events.
                </p>
              </div>
              <RangeControl value={range} onChange={setRange} />
            </div>

            {!hydrated || throughput.isLoading ? (
              <FlowSkeleton />
            ) : throughput.isError ? (
              <ErrorState
                message="The daily flow series isn’t available right now."
                onRetry={() => throughput.refetch()}
              />
            ) : (
              <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
                <div className="grid grid-cols-2 sm:grid-cols-4">
                  {THROUGHPUT_METRICS.map((metric, index) => (
                    <FlowMetric
                      key={metric}
                      metric={metric}
                      current={sumMetric(throughput.current, metric)}
                      previous={sumMetric(throughput.previous, metric)}
                      range={range}
                      className={cn(
                        index % 2 === 0 && "border-r",
                        index < 2 && "border-b",
                        index < 3 && "sm:border-r",
                        "sm:border-b-0",
                      )}
                    />
                  ))}
                </div>

                <div className="border-t border-border/60 px-2 pb-4 pt-5 sm:px-5 sm:pb-5">
                  {hasFlowActivity(throughput.current) ? (
                    <div className="h-[280px] sm:h-[340px]">
                      <ThroughputChart data={throughput.current} />
                    </div>
                  ) : (
                    <div className="grid h-52 place-items-center text-center">
                      <div>
                        <BarChart3 className="mx-auto size-5 text-muted-foreground/50" />
                        <p className="mt-2 text-[12px] font-medium">No flow events in this window</p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          Try a longer range or another project.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function ProjectSelect({
  projectId,
  projects,
  onChange,
}: {
  projectId: number | null;
  projects: { id: number; name: string; color: string }[];
  onChange: (projectId: number | null) => void;
}) {
  return (
    <Select
      value={projectId != null ? String(projectId) : "all"}
      onValueChange={(value) => onChange(value === "all" ? null : Number(value))}
      items={
        {
          all: "All projects",
          ...Object.fromEntries(projects.map((project) => [String(project.id), project.name])),
        } as Record<string, React.ReactNode>
      }
    >
      <SelectTrigger className="ml-auto h-7 w-40 text-[11px] sm:w-44">
        <SelectValue placeholder="Pick a project" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">
          <span className="inline-flex items-center gap-2">
            <Layers className="size-3" /> All projects
          </span>
        </SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={String(project.id)}>
            <span className="inline-flex min-w-0 items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: project.color }}
              />
              <span className="truncate">{project.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WeekSwitcher({
  weekStart,
  onChange,
}: {
  weekStart: string;
  onChange: (weekStart: string) => void;
}) {
  const current = isCurrentWeek(weekStart);
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Selected week">
      <Button
        variant="outline"
        size="icon"
        className="size-7"
        onClick={() => onChange(addWeeksIso(weekStart, -1))}
        aria-label="Previous week"
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <span className="min-w-[124px] text-center text-[11px] font-medium tabular-nums">
        {formatWeekRange(weekStart)}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-7"
        disabled={current}
        onClick={() => onChange(addWeeksIso(weekStart, 1))}
        aria-label="Next week"
      >
        <ChevronRight className="size-3.5" />
      </Button>
      {!current ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px] text-muted-foreground"
          onClick={() => onChange(currentWeekStart())}
        >
          <Undo2 className="size-3" /> This week
        </Button>
      ) : null}
    </div>
  );
}

function RangeControl({
  value,
  onChange,
}: {
  value: ThroughputRange;
  onChange: (range: ThroughputRange) => void;
}) {
  return (
    <div
      className="inline-flex w-fit items-center rounded-md border border-border/70 bg-background p-0.5"
      role="group"
      aria-label="Flow date range"
    >
      {RANGE_OPTIONS.map((range) => (
        <button
          key={range}
          type="button"
          onClick={() => onChange(range)}
          aria-pressed={value === range}
          className={cn(
            "min-h-7 rounded px-3 py-1 text-[10px] font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            value === range
              ? "bg-accent text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {range}d
        </button>
      ))}
    </div>
  );
}

function FlowMetric({
  metric,
  current,
  previous,
  range,
  className,
}: {
  metric: ThroughputMetric;
  current: number;
  previous: number;
  range: ThroughputRange;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 px-4 py-4 sm:px-5", className)}>
      <div className="flex items-center gap-2">
        <span
          className="size-1.5 shrink-0 rounded-full dark:hidden"
          style={{ background: THROUGHPUT_COLORS[metric].light }}
          aria-hidden
        />
        <span
          className="hidden size-1.5 shrink-0 rounded-full dark:inline-block"
          style={{ background: THROUGHPUT_COLORS[metric].dark }}
          aria-hidden
        />
        <span className="truncate text-[10px] font-medium text-muted-foreground">
          {THROUGHPUT_METRIC_LABELS[metric]}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[22px] font-semibold tracking-tight tabular-nums">
          {current.toLocaleString()}
        </span>
        <DeltaIndicator current={current} previous={previous} />
      </div>
      <span className="text-[9px] text-muted-foreground/70">last {range} days</span>
    </div>
  );
}

function sumMetric(days: ThroughputDay[], metric: ThroughputMetric): number {
  return days.reduce((total, day) => total + day[metric], 0);
}

function hasFlowActivity(days: ThroughputDay[]): boolean {
  return days.some((day) => THROUGHPUT_METRICS.some((metric) => day[metric] > 0));
}

function CompletionEmpty({ current }: { current: boolean }) {
  return (
    <div className="grid min-h-32 place-items-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-5 text-center">
      <div>
        <CheckCircle2 className="mx-auto size-5 text-muted-foreground/50" />
        <p className="mt-2 text-[12px] font-medium">
          {current ? "Nothing completed yet this week" : "No completions recorded for this week"}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {current
            ? "Completed work will appear here automatically."
            : "Choose another week to inspect its contribution breakdown."}
        </p>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/35 bg-card px-5 text-center sm:flex-row">
      <AlertTriangle className="size-5 shrink-0 text-destructive/70" />
      <div className="sm:text-left">
        <p className="text-[12px] font-medium">Couldn’t load this report</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="sm:ml-2">
        <RotateCw className="size-3" /> Retry
      </Button>
    </div>
  );
}

function WeeklySkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="grid lg:grid-cols-2">
        <div className="h-52 bg-muted/50" />
        <div className="h-52 border-t border-border/50 bg-muted/30 lg:border-l lg:border-t-0" />
      </div>
      <div className="h-52 border-t border-border/50 bg-muted/20" />
    </div>
  );
}

function FlowSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {THROUGHPUT_METRICS.map((metric) => (
          <div key={metric} className="h-24 border-r border-border/50 bg-muted/40" />
        ))}
      </div>
      <div className="h-72 border-t border-border/50 bg-muted/20" />
    </div>
  );
}

function ChartSkeleton() {
  return <div className="h-full w-full animate-pulse rounded-md bg-muted/50" />;
}
