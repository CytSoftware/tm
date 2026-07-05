"use client";

/**
 * /bets — the Cyt OS bets page.
 *
 * A bet card is deliberately small: name, target/kill criteria, status,
 * and one line per metric — title on the left, latest reading on the
 * right, a contained progress bar underneath, and a Log button beside it.
 * Everything deeper (the log form, the editable check-in history, metric
 * housekeeping) lives in a right slide-over — same backdrop + slide-in
 * idiom as the task panel. Tasks link to bets from the board and task
 * panel; the card itself stays a scoreboard.
 *
 * Periods are the fixed two-month grid in lib/periods.ts (anchored
 * 2026-07-01); the masthead shows the window as a countdown with a time
 * track, and the pace tag compares each metric's progress to it.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Target,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/ColorPicker";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useAddCheckin,
  useBetsQuery,
  useCreateBet,
  useCreateMetric,
  useDeleteBet,
  useDeleteCheckin,
  useDeleteMetric,
  useUpdateBet,
  useUpdateCheckin,
} from "@/hooks/use-bets";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useActiveProject } from "@/lib/active-project";
import { currentPeriodStart, periodLabel, shiftPeriod } from "@/lib/periods";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/components/task/TimeInColumn";
import type { Bet, BetMetric, BetStatus, MetricCheckin, Project } from "@/lib/types";
import { BET_STATUS_LABELS } from "@/lib/types";

const STATUS_TONE: Record<BetStatus, string> = {
  active: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/30",
  won: "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30",
  lost: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/30",
};

export default function BetsPage() {
  const { projectId, setProjectId, hydrated } = useActiveProject();
  const projectsQuery = useProjectsQuery({ includeArchived: false });
  const projects = useMemo(
    () => projectsQuery.data?.results ?? [],
    [projectsQuery.data],
  );

  // Which project(s) the page shows: a project id, or "all" for the
  // cross-project view. `scopeOverride` is what the selector explicitly picks;
  // until then the page follows the active project (falling back to "all"), so
  // it opens where the rest of the app is without a setState-in-effect.
  const [scopeOverride, setScopeOverride] = useState<number | "all" | null>(
    null,
  );
  const scope: number | "all" | null =
    scopeOverride ?? (hydrated ? projectId ?? "all" : null);

  const isAll = scope === "all";
  const project =
    typeof scope === "number"
      ? projects.find((p) => p.id === scope) ?? null
      : null;

  const [period, setPeriod] = useState<string>(() => currentPeriodStart());

  const betsQuery = useBetsQuery(scope, period);
  const bets = useMemo(() => betsQuery.data ?? [], [betsQuery.data]);

  // In the all-projects view, bucket bets under their project so the list
  // reads as a scoreboard per project rather than one undifferentiated pile.
  const groups = useMemo(() => {
    if (!isAll) return [];
    const byProject = new Map<number, Bet[]>();
    for (const b of bets) {
      const list = byProject.get(b.project) ?? [];
      list.push(b);
      byProject.set(b.project, list);
    }
    return [...byProject.entries()]
      .map(([pid, list]) => ({
        project: projects.find((p) => p.id === pid) ?? null,
        bets: list,
      }))
      .sort((a, b) =>
        (a.project?.name ?? "￿").localeCompare(b.project?.name ?? "￿"),
      );
  }, [isAll, bets, projects]);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Bet | null>(null);

  // New bets need a concrete project; editing uses the bet's own project so
  // it works from the all-projects view too.
  const dialogProject = editing
    ? projects.find((p) => p.id === editing.project) ?? null
    : project;

  // The slide-over tracks ids, not objects, so it always renders the fresh
  // copy after a mutation refetch (and closes itself if the metric is gone).
  const [openMetricId, setOpenMetricId] = useState<number | null>(null);
  const openBet =
    bets.find((b) => b.metrics.some((m) => m.id === openMetricId)) ?? null;
  const openMetric =
    openBet?.metrics.find((m) => m.id === openMetricId) ?? null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-border/80 bg-background">
        <Target className="size-4 text-muted-foreground" />
        <h1 className="text-[13px] font-semibold tracking-tight">Bets</h1>
        <Select
          value={isAll ? "all" : project ? String(project.id) : ""}
          onValueChange={(v) => {
            if (v === "all") {
              setScopeOverride("all");
            } else {
              const id = Number(v);
              setScopeOverride(id);
              setProjectId(id);
            }
          }}
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
                <span className="size-2 rounded-full bg-gradient-to-br from-foreground/40 to-foreground/10" />
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
        <div className="flex-1" />
        <Button
          size="sm"
          className="h-7 text-[12px]"
          disabled={!project}
          title={project ? undefined : "Pick a single project to add a bet"}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          New bet
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40 px-4 py-5">
        <div className="max-w-3xl mx-auto">
          <PeriodMasthead period={period} onChange={setPeriod} />

          {!hydrated || projectsQuery.isLoading || scope === null ? null : betsQuery.isLoading ? (
            <div className="grid place-items-center py-16">
              <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
            </div>
          ) : bets.length === 0 ? (
            <EmptyHint
              text={
                isAll
                  ? `No bets for ${periodLabel(period)} across any project. Pick a project to open one.`
                  : `No bets for ${periodLabel(period)} in ${project?.name ?? "this project"}. A bet is the period's wager — name it, give it a number, link the work.`
              }
            />
          ) : isAll ? (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.project?.id ?? "unknown"} className="space-y-3">
                  <ProjectGroupHeader project={g.project} count={g.bets.length} />
                  <div className="space-y-4">
                    {g.bets.map((bet) => (
                      <BetCard
                        key={bet.id}
                        bet={bet}
                        period={period}
                        onEdit={() => setEditing(bet)}
                        onOpenMetric={setOpenMetricId}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {bets.map((bet) => (
                <BetCard
                  key={bet.id}
                  bet={bet}
                  period={period}
                  onEdit={() => setEditing(bet)}
                  onOpenMetric={setOpenMetricId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {dialogProject && (creating || editing) && (
        <BetFormDialog
          project={dialogProject}
          period={period}
          bet={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {openBet && openMetric && (
        <MetricSlideOver
          bet={openBet}
          metric={openMetric}
          period={period}
          onClose={() => setOpenMetricId(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Period masthead — the clock every bet races against
// ─────────────────────────────────────────────────────────────────────────

/** Fraction of the period elapsed right now: 0 before it starts, 1 after
 *  it ends, in between otherwise. */
function elapsedFraction(period: string, now: Date = new Date()): number {
  const start = new Date(`${period}T00:00:00`).getTime();
  const end = new Date(`${shiftPeriod(period, 1)}T00:00:00`).getTime();
  return Math.max(0, Math.min(1, (now.getTime() - start) / (end - start)));
}

/** Countdown line for the period: how alive is this window? */
function periodStatus(period: string): string {
  const start = new Date(`${period}T00:00:00`);
  const end = new Date(`${shiftPeriod(period, 1)}T00:00:00`);
  const now = new Date();
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (now < start) return `starts ${fmt(start)}`;
  if (now >= end) return `ended ${fmt(new Date(end.getTime() - 86_400_000))}`;
  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

function PeriodMasthead({
  period,
  onChange,
}: {
  period: string;
  onChange: (period: string) => void;
}) {
  const isCurrent = period === currentPeriodStart();
  const elapsed = elapsedFraction(period);

  return (
    <div className="mb-5">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => onChange(shiftPeriod(period, -1))}
          aria-label="Previous period"
        >
          <ChevronLeft className="size-4" />
        </Button>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span
              className={cn(
                "text-[17px] font-semibold tracking-tight",
                !isCurrent && "text-amber-600 dark:text-amber-400",
              )}
            >
              {periodLabel(period)}
            </span>
            {!isCurrent && (
              <button
                type="button"
                onClick={() => onChange(currentPeriodStart())}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Undo2 className="size-3" />
                back to now
              </button>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {periodStatus(period)}
            </span>
          </div>
          <div className="relative mt-2 h-[3px] rounded-full bg-border/70">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-foreground/45"
              style={{ width: `${elapsed * 100}%` }}
            />
            {elapsed > 0 && elapsed < 1 && (
              <span
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2 rounded-full bg-foreground ring-2 ring-background"
                style={{ left: `${elapsed * 100}%` }}
                title="Today"
              />
            )}
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => onChange(shiftPeriod(period, 1))}
          aria-label="Next period"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="max-w-md mx-auto mt-14 grid place-items-center py-12 px-6 text-center text-[12px] text-muted-foreground rounded-lg border border-dashed border-border/60">
      {text}
    </div>
  );
}

/** Section label above each project's bets in the all-projects view. */
function ProjectGroupHeader({
  project,
  count,
}: {
  project: Project | null;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span
        className="size-2 rounded-full shrink-0"
        style={{ background: project?.color ?? "var(--muted-foreground)" }}
      />
      <h2 className="text-[12px] font-semibold tracking-tight text-foreground/80">
        {project?.name ?? "Unknown project"}
      </h2>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {count} bet{count === 1 ? "" : "s"}
      </span>
      <div className="flex-1 h-px bg-border/60" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Bet card — name, thesis, status, one metric line each. Nothing hidden.
// ─────────────────────────────────────────────────────────────────────────

function BetCard({
  bet,
  period,
  onEdit,
  onOpenMetric,
}: {
  bet: Bet;
  period: string;
  onEdit: () => void;
  onOpenMetric: (metricId: number) => void;
}) {
  const updateBet = useUpdateBet();
  const deleteBet = useDeleteBet();

  function handleDelete() {
    if (
      !confirm(
        `Delete bet "${bet.name}"?\n\nLinked tasks are kept — they just lose the link. Metrics and their check-in logs are deleted.`,
      )
    ) {
      return;
    }
    deleteBet.mutate(bet.id);
  }

  return (
    <section className="group/card rounded-lg border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] px-5 py-4">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: bet.color }}
        />
        <h2 className="text-[15px] font-semibold tracking-tight truncate flex-1">
          {bet.name}
        </h2>
        <div className="flex items-center opacity-0 group-hover/card:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            onClick={onEdit}
            aria-label="Edit bet"
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            aria-label="Delete bet"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
        <Select
          value={bet.status}
          onValueChange={(v) =>
            v !== bet.status &&
            updateBet.mutate({ id: bet.id, status: v as BetStatus })
          }
          items={BET_STATUS_LABELS as Record<string, React.ReactNode>}
        >
          <SelectTrigger
            className={cn(
              "h-6 w-auto gap-1 rounded-md border px-2 text-[11px] font-medium shrink-0",
              STATUS_TONE[bet.status],
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(BET_STATUS_LABELS) as BetStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {BET_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {bet.description ? (
        <p className="mt-1 pl-4 text-[12px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {bet.description}
        </p>
      ) : (
        <button
          type="button"
          onClick={onEdit}
          className="mt-1 pl-4 text-[12px] text-muted-foreground/60 italic hover:text-foreground transition-colors text-left"
        >
          No target or kill criteria written — click to add them.
        </button>
      )}

      <div className="mt-2 divide-y divide-border/40">
        {bet.metrics.map((m) => (
          <MetricLine
            key={m.id}
            metric={m}
            color={bet.color}
            period={period}
            onOpen={() => onOpenMetric(m.id)}
          />
        ))}
        <div className={cn(bet.metrics.length > 0 ? "pt-2.5" : "pt-3")}>
          <AddMetricRow betId={bet.id} minimal={bet.metrics.length > 0} />
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Metric line — title · reading · Log, with a contained bar underneath
// ─────────────────────────────────────────────────────────────────────────

/** Pace verdict: latest reading vs. where the target says you should be,
 *  given how much of the period has burned. Only meaningful mid-period on
 *  a metric with both a value and a target. */
function paceOf(
  value: number,
  target: number,
  period: string,
): "ahead" | "behind" | null {
  const f = elapsedFraction(period);
  if (f <= 0 || f >= 1 || target <= 0) return null;
  return value >= target * f ? "ahead" : "behind";
}

function MetricLine({
  metric,
  color,
  period,
  onOpen,
}: {
  metric: BetMetric;
  color: string;
  period: string;
  onOpen: () => void;
}) {
  const latest = metric.checkins[0] ?? null;
  const latestValue = latest?.value ?? null;
  const pace =
    latestValue != null && metric.target != null
      ? paceOf(latestValue, metric.target, period)
      : null;

  return (
    // One row per metric: fixed-width title column so every bar starts at
    // the same x, bar inline beside the title, reading after it. Metrics
    // without a target skip the bar — just the latest input and Log.
    // Rows get real height and hairline separation so the list breathes.
    <div className="py-3 flex items-center gap-4">
      <button
        type="button"
        onClick={onOpen}
        title={metric.name}
        className="w-40 shrink-0 truncate text-left text-[12px] font-medium hover:text-foreground/80 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded-sm"
      >
        {metric.name}
      </button>

      {metric.target != null ? (
        <>
          {/* Constant bar length — every bar starts *and* ends at the same
              x, regardless of how wide the name or the reading is. */}
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${metric.name} check-in history`}
            className="w-full max-w-[300px] shrink h-1.5 rounded-full bg-muted overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            {latestValue != null && (
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${Math.max(0, Math.min(100, (latestValue / metric.target) * 100))}%`,
                  background: color,
                }}
              />
            )}
          </button>
          <span className="shrink-0 flex items-baseline gap-1.5 whitespace-nowrap">
            {latestValue != null ? (
              <>
                <span className="font-mono text-[14px] font-semibold tabular-nums">
                  {trimNumber(latestValue)}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  of {trimNumber(metric.target)}
                  {metric.unit && ` ${metric.unit}`}
                </span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground/60">
                no check-ins yet
              </span>
            )}
            {pace === "ahead" && (
              <span
                title="Ahead of pace for this period"
                className="text-[10px] font-medium text-green-600 dark:text-green-400"
              >
                ▲
              </span>
            )}
            {pace === "behind" && (
              <span
                title="Behind pace for this period"
                className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
              >
                ▼
              </span>
            )}
          </span>
        </>
      ) : (
        // No target → no bar. The latest input starts where the bars do,
        // keeping one left rhythm down the whole list.
        <span className="min-w-0 truncate">
          {latestValue != null ? (
            <span className="font-mono text-[14px] font-semibold tabular-nums">
              {trimNumber(latestValue)}
              {metric.unit && (
                <span className="ml-1 font-sans text-[11px] font-normal text-muted-foreground">
                  {metric.unit}
                </span>
              )}
            </span>
          ) : latest ? (
            <span className="text-[11px] text-muted-foreground italic">
              “{latest.note}”
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground/60">
              no check-ins yet
            </span>
          )}
        </span>
      )}

      <span className="flex-1" />
      <Button
        size="sm"
        variant="outline"
        className="h-5 px-1.5 text-[10px] shrink-0"
        onClick={onOpen}
      >
        Log
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Metric slide-over — log a check-in, read & edit the history
// ─────────────────────────────────────────────────────────────────────────

function MetricSlideOver({
  bet,
  metric,
  period,
  onClose,
}: {
  bet: Bet;
  metric: BetMetric;
  period: string;
  onClose: () => void;
}) {
  const deleteMetric = useDeleteMetric();
  const latest = metric.checkins[0] ?? null;
  const latestValue = latest?.value ?? null;
  const pace =
    latestValue != null && metric.target != null
      ? paceOf(latestValue, metric.target, period)
      : null;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md flex flex-col bg-card border-l border-border shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="shrink-0 flex items-start gap-3 px-5 py-4 border-b border-border/60">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight truncate">
              {metric.name}
            </h2>
            <p className="text-[11px] text-muted-foreground truncate">
              <span
                className="inline-block size-1.5 rounded-full mr-1.5 align-middle"
                style={{ background: bet.color }}
              />
              {bet.name}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* Current reading */}
          <div>
            <div className="flex items-baseline gap-2">
              {latestValue != null ? (
                <>
                  <span className="font-mono text-[26px] font-semibold tabular-nums leading-none">
                    {trimNumber(latestValue)}
                  </span>
                  <span className="text-[12px] text-muted-foreground tabular-nums">
                    {metric.target != null && `of ${trimNumber(metric.target)}`}
                    {metric.unit && ` ${metric.unit}`}
                  </span>
                </>
              ) : latest ? (
                <span className="text-[13px] text-muted-foreground italic">
                  “{latest.note}”
                </span>
              ) : (
                <span className="text-[12px] text-muted-foreground/60">
                  No check-ins yet — log the first reading below.
                </span>
              )}
              {pace === "ahead" && (
                <span className="text-[10px] font-medium text-green-600 dark:text-green-400">
                  ▲ ahead of pace
                </span>
              )}
              {pace === "behind" && (
                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  ▼ behind pace
                </span>
              )}
            </div>
            {metric.target != null && (
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${latestValue != null ? Math.max(0, Math.min(100, (latestValue / metric.target) * 100)) : 0}%`,
                    background: bet.color,
                  }}
                />
              </div>
            )}
          </div>

          {/* Log form */}
          <CheckinForm metricId={metric.id} />

          {/* History — every entry editable in place, deletable. */}
          <div className="space-y-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              History
            </span>
            {metric.checkins.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Nothing logged yet.
              </p>
            )}
            {metric.checkins.map((c) => (
              <EditableCheckinRow key={c.id} checkin={c} />
            ))}
          </div>
        </div>

        {/* Housekeeping */}
        <div className="shrink-0 px-5 py-3 border-t border-border/60">
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete metric "${metric.name}" and its log?`)) {
                deleteMetric.mutate(metric.id, { onSuccess: onClose });
              }
            }}
            className="text-[11px] text-muted-foreground/70 hover:text-destructive transition-colors"
          >
            Delete metric
          </button>
        </div>
      </div>
    </>
  );
}

function CheckinForm({ metricId }: { metricId: number }) {
  const addCheckin = useAddCheckin();
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const canLog = value.trim() !== "" || note.trim() !== "";

  function submit() {
    if (!canLog || addCheckin.isPending) return;
    addCheckin.mutate(
      {
        metric: metricId,
        value: value.trim() === "" ? null : Number(value),
        note: note.trim(),
      },
      {
        onSuccess: () => {
          setValue("");
          setNote("");
        },
      },
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="#"
        autoFocus
        className="h-7 w-16 text-[12px] px-1.5"
      />
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Note (optional for numbers)"
        className="h-7 flex-1 text-[12px] px-1.5"
      />
      <Button
        size="sm"
        className="h-7 px-2.5 text-[12px]"
        disabled={!canLog || addCheckin.isPending}
        onClick={submit}
      >
        Log
      </Button>
    </div>
  );
}

function EditableCheckinRow({ checkin }: { checkin: MetricCheckin }) {
  const updateCheckin = useUpdateCheckin();
  const deleteCheckin = useDeleteCheckin();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    checkin.value != null ? String(checkin.value) : "",
  );
  const [note, setNote] = useState(checkin.note);
  const canSave = value.trim() !== "" || note.trim() !== "";

  function save() {
    if (!canSave || updateCheckin.isPending) return;
    updateCheckin.mutate(
      {
        id: checkin.id,
        value: value.trim() === "" ? null : Number(value),
        note: note.trim(),
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="#"
          autoFocus
          className="h-6 w-16 text-[11px] px-1.5"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="Note"
          className="h-6 flex-1 text-[11px] px-1.5"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-1.5 text-[11px]"
          disabled={!canSave || updateCheckin.isPending}
          onClick={save}
          aria-label="Save check-in"
        >
          <Check className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => {
            setValue(checkin.value != null ? String(checkin.value) : "");
            setNote(checkin.note);
            setEditing(false);
          }}
          aria-label="Cancel edit"
        >
          <X className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 text-[12px] leading-tight">
      <span className="size-1 rounded-full bg-muted-foreground/40 mt-1.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">
          {checkin.value != null && (
            <span className="font-mono font-medium tabular-nums">
              {trimNumber(checkin.value)}
            </span>
          )}
          {checkin.value != null && checkin.note && (
            <span className="text-muted-foreground"> · </span>
          )}
          {checkin.note}
        </span>
        <div className="text-[11px] text-muted-foreground/80">
          {checkin.created_by?.username ?? "agent"} ·{" "}
          {formatDuration(checkin.created_at)} ago
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit check-in"
          className="text-muted-foreground/60 hover:text-foreground transition-colors p-0.5"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => deleteCheckin.mutate(checkin.id)}
          aria-label="Delete check-in"
          className="text-muted-foreground/60 hover:text-destructive transition-colors p-0.5"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Add metric
// ─────────────────────────────────────────────────────────────────────────

function AddMetricRow({
  betId,
  minimal,
}: {
  betId: number;
  /** With metrics already present the affordance shrinks to a quiet link;
   *  on a metric-less bet it stays a visible bordered row so the next step
   *  is obvious. */
  minimal: boolean;
}) {
  const createMetric = useCreateMetric();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors",
          minimal
            ? "py-0.5"
            : "w-full justify-center rounded-md border border-dashed border-border/60 py-2",
        )}
      >
        <Plus className="size-3" />
        {minimal ? "Add metric" : "Add a metric — what number proves this bet?"}
      </button>
    );
  }

  function submit() {
    if (!name.trim()) return;
    createMetric.mutate(
      {
        bet: betId,
        name: name.trim(),
        target: target.trim() === "" ? null : Number(target),
        unit: unit.trim(),
      },
      {
        onSuccess: () => {
          setName("");
          setTarget("");
          setUnit("");
          setOpen(false);
        },
      },
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Metric name"
        autoFocus
        className="h-6 flex-1 text-[11px] px-1.5"
      />
      <Input
        type="number"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="Target"
        className="h-6 w-16 text-[11px] px-1.5"
      />
      <Input
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        placeholder="Unit"
        className="h-6 w-20 text-[11px] px-1.5"
      />
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={!name.trim() || createMetric.isPending}
        onClick={submit}
      >
        <Check className="size-3" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-[11px]"
        onClick={() => setOpen(false)}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Create / edit dialog
// ─────────────────────────────────────────────────────────────────────────

function BetFormDialog({
  project,
  period,
  bet,
  onClose,
}: {
  project: Project;
  /** ISO period start the page is currently showing — new bets land there. */
  period: string;
  /** Existing bet when editing; null when creating. */
  bet: Bet | null;
  onClose: () => void;
}) {
  const createBet = useCreateBet();
  const updateBet = useUpdateBet();
  const [name, setName] = useState(bet?.name ?? "");
  const [description, setDescription] = useState(bet?.description ?? "");
  const [color, setColor] = useState(bet?.color ?? "#6366f1");
  const saving = createBet.isPending || updateBet.isPending;

  async function submit() {
    if (!name.trim()) return;
    if (bet) {
      await updateBet.mutateAsync({
        id: bet.id,
        name: name.trim(),
        description,
        color,
      });
    } else {
      await createBet.mutateAsync({
        project: project.id,
        name: name.trim(),
        description,
        color,
        period_start: period,
      });
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {bet
              ? `Edit bet — ${bet.name}`
              : `New bet · ${periodLabel(period)}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bet name — the wager in one line"
            autoFocus
            className="text-[13px]"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Target and kill criteria — what does won look like, when do you fold?"
            rows={4}
            className="text-[12px]"
          />
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : bet ? "Save" : "Create bet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "10.0" → "10", "12.5" stays "12.5". */
function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
