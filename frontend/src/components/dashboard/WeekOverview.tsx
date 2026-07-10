"use client";

/**
 * Dashboard "This week" pulse — total tasks completed this week (all
 * projects) + delta vs last week, and a compact top-4 per-person breakdown
 * with proportional bars. Same `useWeeklyCompletionsQuery` as /analytics,
 * scoped to the current week / all projects, so the two views never
 * disagree. Quiet like the other dashboard cards: a broken query hides the
 * whole card rather than showing an error banner on the home page; an empty
 * week still shows the card with a one-line message, matching MyTasks'
 * "enjoy the quiet" treatment.
 */

import { useRouter } from "next/navigation";
import { ArrowUpRight, TrendingUp } from "lucide-react";

import { UserAvatar } from "@/components/UserAvatar";
import { DeltaIndicator } from "@/components/analytics/DeltaIndicator";
import { currentWeekStart, useWeeklyCompletionsQuery } from "@/hooks/use-analytics";
import { COMPLETIONS_MUTED } from "@/lib/chart-colors";
import type { CompletionsPerson } from "@/lib/types";
import { cn } from "@/lib/utils";

const TOP_N = 4;

export function WeekOverview() {
  const router = useRouter();
  const query = useWeeklyCompletionsQuery({
    projectId: null,
    weekStart: currentWeekStart(),
  });

  // A broken query is not worth a banner on the home page — the full detail
  // (with retry) lives on /analytics.
  if (query.isError) return null;

  const data = query.data;
  const isLoading = query.isLoading;
  const top = data?.per_person.slice(0, TOP_N) ?? [];
  const overflow = data ? Math.max(0, data.per_person.length - TOP_N) : 0;
  const maxCount = top.reduce((m, p) => Math.max(m, p.count), 0);

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <TrendingUp className="size-3" />
        This week
        <button
          type="button"
          onClick={() => router.push("/analytics")}
          className="ml-auto inline-flex items-center gap-0.5 normal-case tracking-normal text-muted-foreground hover:text-foreground transition-colors"
        >
          View analytics
          <ArrowUpRight className="size-3" />
        </button>
      </h2>

      <div className="rounded-lg border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] px-4 py-3.5">
        {isLoading ? (
          <div className="grid place-items-center py-6">
            <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
          </div>
        ) : !data || data.total === 0 ? (
          <p className="py-2 text-center text-[12px] text-muted-foreground">
            Nothing completed yet this week.
          </p>
        ) : (
          <>
            <div className="flex items-baseline gap-2.5">
              <span className="text-[22px] font-semibold tracking-tight">
                {data.total.toLocaleString()} done
              </span>
              <DeltaIndicator
                current={data.total}
                previous={data.prev_total}
                suffix="vs last week"
              />
            </div>

            <div className="mt-3 space-y-1.5">
              {top.map((p) => (
                <PersonRow key={p.user_id ?? "unassigned"} person={p} max={maxCount} />
              ))}
              {overflow > 0 && (
                <p className="pt-0.5 text-[11px] text-muted-foreground/70">
                  +{overflow} more
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PersonRow({ person, max }: { person: CompletionsPerson; max: number }) {
  const isUnassigned = person.user_id == null;
  const pct = max > 0 ? Math.max(6, Math.round((person.count / max) * 100)) : 0;

  return (
    <div className="flex items-center gap-2">
      {isUnassigned ? (
        <span className="size-4 rounded-full bg-muted-foreground/25 shrink-0" />
      ) : (
        <UserAvatar
          username={person.username ?? "?"}
          avatarUrl={person.avatar_url ?? undefined}
          size="size-4"
        />
      )}
      <span
        className={
          isUnassigned
            ? "w-16 shrink-0 truncate text-[11.5px] italic text-muted-foreground/70"
            : "w-16 shrink-0 truncate text-[11.5px] text-foreground"
        }
      >
        {isUnassigned ? "Unassigned" : person.username}
      </span>
      <div className="h-1.5 flex-1 min-w-0 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            !isUnassigned && "bg-[#2a78d6] dark:bg-[#3987e5]",
          )}
          style={{
            width: `${pct}%`,
            background: isUnassigned ? COMPLETIONS_MUTED : undefined,
          }}
        />
      </div>
      <span className="w-4 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground">
        {person.count}
      </span>
    </div>
  );
}
