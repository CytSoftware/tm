"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { routinesKey } from "@/lib/query-keys";
import { connectProjectSocket } from "@/lib/ws";

type Routine = {
  id: number;
  external_id: string;
  name: string;
  instructions: string;
  trigger_type: "schedule" | "webhook" | "manual";
  trigger_description: string;
  enabled: boolean;
  skills: string[];
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string;
  synced_at: string;
};

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function RoutinesPage() {
  const [offset, setOffset] = useState(0);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...routinesKey(), offset],
    queryFn: () => apiFetch<{ count: number; results: Routine[]; next: string | null }>("/api/integrations/routines/", { query: { limit: 50, offset } }),
    refetchInterval: 30_000,
  });
  useEffect(() => connectProjectSocket({
    projectId: 0,
    queryClient,
    onEvent: event => {
      if (event.type.startsWith("routine.")) void queryClient.invalidateQueries({ queryKey: routinesKey() });
    },
  }), [queryClient]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <Repeat className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Routines</h1>
        <span className="text-xs text-muted-foreground">{query.data?.count ?? "—"} routines</span>
        <Button className="ml-auto" size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw className="size-3.5" />Refresh</Button>
        <Button size="sm" variant="outline" render={<a href="https://t.me/CytAiBot" target="_blank" rel="noopener noreferrer" />}>Open Hermes</Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-6">
          <p className="text-sm text-muted-foreground">Managed through Hermes chat. Ask Hermes to create, edit, pause, or remove a routine. This page shows the last synchronized state.</p>
          {query.isError && <p role="alert" className="text-sm text-destructive">Couldn’t refresh routines. Any displayed records may be outdated. Use Refresh to retry.</p>}
          {query.isPending ? <p role="status" className="py-12 text-center text-muted-foreground">Loading routines…</p> : query.data?.results.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <h2 className="font-medium">{offset ? "No routines on this page" : "No routines synchronized yet"}</h2>
              <p className="mt-2 text-sm text-muted-foreground">Ask Hermes to synchronize its routines with CytHQ.</p>
            </div>
          ) : query.data?.results.map(routine => (
            <article key={routine.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start gap-2">
                <h2 className="min-w-0 flex-1 break-words text-sm font-semibold">{routine.name}</h2>
                <span className={`rounded-full px-2 py-0.5 text-xs ${routine.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>{routine.enabled ? "Enabled" : "Paused"}</span>
              </div>
              <p className="mt-2 break-words text-sm"><span className="capitalize text-muted-foreground">{routine.trigger_type}: </span>{routine.trigger_description}</p>
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
                <div><dt className="text-muted-foreground">Next scheduled run</dt><dd className="mt-1">{routine.enabled ? date(routine.next_run_at) : "Paused"}</dd></div>
                <div><dt className="text-muted-foreground">Last run</dt><dd className="mt-1">{date(routine.last_run_at)}</dd></div>
                <div><dt className="text-muted-foreground">Last reported status</dt><dd className="mt-1">{routine.last_run_status || "Not reported"}</dd></div>
              </dl>
              <details className="mt-4 border-t pt-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">Instructions and details</summary>
                <p className="mt-3 whitespace-pre-wrap break-words">{routine.instructions || "No instructions synchronized."}</p>
                {routine.skills.length > 0 && <p className="mt-3 break-words text-xs text-muted-foreground">Skills: {routine.skills.join(", ")}</p>}
                <p className="mt-3 break-all font-mono text-xs text-muted-foreground">{routine.external_id}</p>
              </details>
              <p className="mt-3 text-[11px] text-muted-foreground">Last synchronized: {date(routine.synced_at)} · Times shown in your local timezone</p>
            </article>
          ))}
          {(offset > 0 || query.data?.next) && <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
            <span className="text-xs text-muted-foreground">Page {offset / 50 + 1}</span>
            <Button variant="outline" size="sm" disabled={!query.data?.next || query.isFetching} onClick={() => setOffset(offset + 50)}>Next</Button>
          </div>}
        </div>
      </main>
    </div>
  );
}
