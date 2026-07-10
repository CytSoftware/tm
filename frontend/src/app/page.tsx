"use client";

/**
 * / — the home dashboard.
 *
 * One glance answers four questions: where are we in the current two-month
 * period, how are the bets doing (team-wide, every project), how much did we
 * get done this week, and what's on my plate. The period masthead reuses the
 * bets page's clock and navigates periods — browse back to see how past bets
 * closed, or forward to place next period's bets. The bets column follows
 * the selected period (new bets and check-in history in place); This week,
 * My Tasks, and Activity stay pinned to now.
 *
 * Freshness: no project sockets here — the sections poll every 60s, the
 * global notification socket prepends activity live, and Shell invalidates
 * my-tasks when a notification lands.
 */

import { useState } from "react";
import { Home } from "lucide-react";

import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { BetsOverview } from "@/components/dashboard/BetsOverview";
import { MyTasks } from "@/components/dashboard/MyTasks";
import { WeekOverview } from "@/components/dashboard/WeekOverview";
import { PeriodMasthead } from "@/components/bets/PeriodMasthead";
import { currentPeriodStart } from "@/lib/periods";

export default function DashboardPage() {
  const [period, setPeriod] = useState<string>(() => currentPeriodStart());

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-border/80 bg-background">
        <Home className="size-4 text-muted-foreground" />
        <h1 className="text-[13px] font-semibold tracking-tight">Home</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40 px-4 py-5">
        <PeriodMasthead period={period} onChange={setPeriod} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <div className="min-w-0">
            <BetsOverview period={period} />
          </div>
          <div className="min-w-0 space-y-5 order-first lg:order-none">
            <WeekOverview />
            <MyTasks />
            <ActivityFeed />
          </div>
        </div>
      </div>
    </div>
  );
}
