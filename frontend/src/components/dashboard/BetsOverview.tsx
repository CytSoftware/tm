"use client";

/**
 * Dashboard bets overview — every project's bets for the selected two-month
 * period, grouped by project. The period follows the masthead's navigation,
 * so past periods read as a record of how their bets closed and the next
 * period is where new bets get placed ("New bet" opens the shared dialog
 * with a project picker). Clicking a metric opens the check-in slide-over —
 * full log history and quick logging without leaving the page. Clicking a
 * bet name lands on /bets scoped to that project.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BetFormDialog } from "@/components/bets/BetFormDialog";
import { BetTasksSummary } from "@/components/bets/BetTasksSummary";
import { MetricLine } from "@/components/bets/MetricLine";
import { MetricSlideOver } from "@/components/bets/MetricSlideOver";
import { useAllBetsQuery } from "@/hooks/use-bets";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useActiveProject } from "@/lib/active-project";
import { periodLabel } from "@/lib/periods";
import { cn } from "@/lib/utils";
import type { Bet } from "@/lib/types";
import { BET_STATUS_LABELS, BET_STATUS_TONE } from "@/lib/types";

export function BetsOverview({ period }: { period: string }) {
  const betsQuery = useAllBetsQuery(period);
  const bets = useMemo(() => betsQuery.data ?? [], [betsQuery.data]);

  const projectsQuery = useProjectsQuery({ includeArchived: false });
  const projects = projectsQuery.data?.results ?? [];

  const [creating, setCreating] = useState<{ projectId: number | null } | null>(
    null,
  );

  // The slide-over tracks ids, not objects, so it always renders the fresh
  // copy after a mutation refetch (and closes itself if the metric is gone).
  const [openMetricId, setOpenMetricId] = useState<number | null>(null);
  const openBet =
    bets.find((b) => b.metrics.some((m) => m.id === openMetricId)) ?? null;
  const openMetric =
    openBet?.metrics.find((m) => m.id === openMetricId) ?? null;

  const groups = useMemo(() => {
    const byProject = new Map<number, { name: string; bets: Bet[] }>();
    for (const bet of bets) {
      const group = byProject.get(bet.project) ?? {
        name: bet.project_name,
        bets: [],
      };
      group.bets.push(bet);
      byProject.set(bet.project, group);
    }
    return [...byProject.entries()]
      .map(([projectId, group]) => ({ projectId, ...group }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [bets]);

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Target className="size-3" />
        Bets · {periodLabel(period)}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10px] normal-case tracking-normal"
          disabled={projects.length === 0}
          onClick={() => setCreating({ projectId: null })}
        >
          <Plus className="size-3" />
          New bet
        </Button>
      </h2>

      {betsQuery.isLoading ? (
        <div className="grid place-items-center rounded-lg border border-border/60 bg-card py-16">
          <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
        </div>
      ) : bets.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-border/60 py-12 px-6 text-center text-[12px] text-muted-foreground">
          <span>
            No bets for {periodLabel(period)}{" "}yet. A bet is the
            period&apos;s wager — name it, give it a number, link the work.
          </span>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            disabled={projects.length === 0}
            onClick={() => setCreating({ projectId: null })}
          >
            <Plus className="size-3.5" />
            Place the first bet
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.projectId}>
              <h3 className="mb-1.5 flex items-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                {group.name}
                <button
                  type="button"
                  onClick={() => setCreating({ projectId: group.projectId })}
                  aria-label={`New bet in ${group.name}`}
                  className="ml-1.5 inline-flex text-muted-foreground/60 hover:text-foreground transition-colors"
                >
                  <Plus className="size-3" />
                </button>
              </h3>
              <div className="space-y-3">
                {group.bets.map((bet) => (
                  <DashboardBetCard
                    key={bet.id}
                    bet={bet}
                    period={period}
                    onOpenMetric={setOpenMetricId}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && projects.length > 0 && (
        <BetFormDialog
          projects={projects}
          initialProjectId={creating.projectId}
          period={period}
          bet={null}
          onClose={() => setCreating(null)}
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
    </section>
  );
}

function DashboardBetCard({
  bet,
  period,
  onOpenMetric,
}: {
  bet: Bet;
  period: string;
  onOpenMetric: (metricId: number) => void;
}) {
  const router = useRouter();
  const { setProjectId } = useActiveProject();

  function openOnBetsPage() {
    setProjectId(bet.project);
    router.push("/bets");
  }

  return (
    <section className="rounded-lg border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] px-5 py-3.5">
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: bet.color }}
        />
        <button
          type="button"
          onClick={openOnBetsPage}
          className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold tracking-tight hover:text-foreground/80 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded-sm"
        >
          {bet.name}
        </button>
        <span
          className={cn(
            "h-6 inline-flex items-center rounded-md border px-2 text-[11px] font-medium shrink-0",
            BET_STATUS_TONE[bet.status],
          )}
        >
          {BET_STATUS_LABELS[bet.status]}
        </span>
      </div>

      {(bet.metrics.length > 0 || bet.task_count > 0) && (
        <div className="mt-1 divide-y divide-border/40">
          <BetTasksSummary bet={bet} />
          {bet.metrics.map((m) => (
            <MetricLine
              key={m.id}
              metric={m}
              color={bet.color}
              period={period}
              onOpen={() => onOpenMetric(m.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
