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

import { useMemo, useState } from "react";
import { Check, Pencil, Plus, Target, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useBetsQuery,
  useCreateMetric,
  useDeleteBet,
  useUpdateBet,
} from "@/hooks/use-bets";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useActiveProject } from "@/lib/active-project";
import { currentPeriodStart, periodLabel } from "@/lib/periods";
import { cn } from "@/lib/utils";
import { BetFormDialog } from "@/components/bets/BetFormDialog";
import { BetTasksSummary } from "@/components/bets/BetTasksSummary";
import { MetricLine } from "@/components/bets/MetricLine";
import { MetricSlideOver } from "@/components/bets/MetricSlideOver";
import { PeriodMasthead } from "@/components/bets/PeriodMasthead";
import type { Bet, BetStatus, Project } from "@/lib/types";
import { BET_STATUS_LABELS, BET_STATUS_TONE } from "@/lib/types";

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
      <header className="shrink-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 max-lg:px-3 py-1.5 border-b border-border/80 bg-background">
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
          <SelectTrigger className="h-7 w-44 max-lg:w-36 text-[12px]">
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
          projects={[dialogProject]}
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
        <div className="flex items-center opacity-0 group-hover/card:opacity-100 hover-none:opacity-100 transition-opacity">
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
              BET_STATUS_TONE[bet.status],
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
        <BetTasksSummary bet={bet} expandable />
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
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Metric name"
        autoFocus
        className="h-6 flex-1 basis-32 text-[11px] px-1.5"
      />
      <Input
        type="number"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="Target"
        className="h-6 w-16 max-lg:flex-1 text-[11px] px-1.5"
      />
      <Input
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        placeholder="Unit"
        className="h-6 w-20 max-lg:flex-1 text-[11px] px-1.5"
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
