"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { routinesKey } from "@/lib/query-keys";
import { errorText, formatDate, statusLabel, statusStyle, type Routine } from "@/lib/routines";

export default function RoutinesPage() {
  const query = useQuery({
    queryKey: routinesKey(),
    queryFn: () => apiFetch<{ results: Routine[] }>("/api/integrations/routines/"),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 max-lg:px-3 py-1.5 border-b border-border/80 bg-background">
        <Repeat className="size-4 text-muted-foreground" />
        <h1 className="text-[13px] font-semibold tracking-tight">Routines</h1>
        <span className="text-[11px] tabular-nums text-muted-foreground">{query.data?.results.length ?? "—"} routines</span>
        <Button className="ml-auto h-7 text-[12px] tap-target" size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw className="size-3.5" />Refresh</Button>
        <Button className="h-7 text-[12px] tap-target" size="sm" variant="outline" render={<a href="https://t.me/CytAiBot" target="_blank" rel="noopener noreferrer" />}>Open Hermes</Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-4 p-4">
          <p className="text-sm text-muted-foreground">Live from Hermes. Ask Hermes to create, schedule, pause, or remove a routine. Times shown in your local timezone.</p>
          {query.isError && <p role="alert" className="text-sm text-destructive">Couldn’t load routines from Hermes: {errorText(query.error)}. Use Refresh to retry.</p>}
          {query.isPending ? <p role="status" className="py-12 text-center text-muted-foreground">Loading routines…</p> : query.data?.results.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <h2 className="font-medium">No routines yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">Ask Hermes to create one.</p>
            </div>
          ) : query.data?.results.map(routine => (
            <Link key={routine.id} href={`/routines/${routine.id}`} className="block rounded-lg border bg-card p-4 transition-colors hover:bg-accent/40">
              <div className="flex flex-wrap items-start gap-2">
                <h2 className="min-w-0 flex-1 break-words text-sm font-semibold">{routine.name}</h2>
                <span className={`rounded-full px-2 py-0.5 text-xs ${routine.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>{routine.enabled ? "Enabled" : "Paused"}</span>
              </div>
              <p className="mt-2 break-words font-mono text-xs text-muted-foreground">{routine.schedule_display}</p>
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
                <div><dt className="text-muted-foreground">Next run</dt><dd className="mt-1">{routine.enabled ? formatDate(routine.next_run_at) : "Paused"}</dd></div>
                <div><dt className="text-muted-foreground">Last run</dt><dd className="mt-1">{formatDate(routine.last_run_at)}</dd></div>
                <div><dt className="text-muted-foreground">Last status</dt><dd className="mt-1"><span className={`rounded-full px-2 py-0.5 ${statusStyle(routine.last_status)}`}>{routine.last_run_at ? statusLabel(routine.last_status) : "Never run"}</span></dd></div>
              </dl>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
