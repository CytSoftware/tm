"use client";

/**
 * Dashboard bets overview — every project's bets for the current two-month
 * period, grouped by project. Read-only scoreboard: metric lines and the
 * linked-task fraction, no editing. Clicking a bet lands on /bets scoped to
 * that project.
 */

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Target } from "lucide-react";

import { BetTasksSummary } from "@/components/bets/BetTasksSummary";
import { MetricLine } from "@/components/bets/MetricLine";
import { useAllBetsQuery } from "@/hooks/use-bets";
import { useActiveProject } from "@/lib/active-project";
import { currentPeriodStart, periodLabel } from "@/lib/periods";
import { cn } from "@/lib/utils";
import type { Bet } from "@/lib/types";
import { BET_STATUS_LABELS, BET_STATUS_TONE } from "@/lib/types";

export function BetsOverview() {
  const period = currentPeriodStart();
  const betsQuery = useAllBetsQuery(period);
  const bets = useMemo(() => betsQuery.data ?? [], [betsQuery.data]);

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
        Bets this period
      </h2>

      {betsQuery.isLoading ? (
        <div className="grid place-items-center rounded-lg border border-border/60 bg-card py-16">
          <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
        </div>
      ) : bets.length === 0 ? (
        <div className="grid place-items-center rounded-lg border border-dashed border-border/60 py-12 px-6 text-center text-[12px] text-muted-foreground">
          No bets for {periodLabel(period)} yet — place them on the Bets page.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.projectId}>
              <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                {group.name}
              </h3>
              <div className="space-y-3">
                {group.bets.map((bet) => (
                  <DashboardBetCard
                    key={bet.id}
                    bet={bet}
                    period={period}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DashboardBetCard({ bet, period }: { bet: Bet; period: string }) {
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
            <MetricLine key={m.id} metric={m} color={bet.color} period={period} />
          ))}
        </div>
      )}
    </section>
  );
}
