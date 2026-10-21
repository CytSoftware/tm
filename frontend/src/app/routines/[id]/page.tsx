"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { routineKey, routineRunsKey, routinesKey } from "@/lib/query-keys";
import { errorText, formatDate, statusLabel, statusStyle, type Routine, type RoutineRun, type TranscriptMessage } from "@/lib/routines";

// Hermes rejects longer prompts (api_server _MAX_PROMPT_LENGTH).
const MAX_PROMPT = 5000;

export default function RoutinePage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const routine = useQuery({
    queryKey: routineKey(id),
    queryFn: () => apiFetch<Routine>(`/api/integrations/routines/${id}/`),
  });
  const runs = useQuery({
    queryKey: routineRunsKey(id),
    queryFn: () => apiFetch<{ results: RoutineRun[] }>(`/api/integrations/routines/${id}/runs/`),
    refetchInterval: 15_000,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const prompt = draft ?? routine.data?.prompt ?? "";

  const save = useMutation({
    mutationFn: () => apiFetch<Routine>(`/api/integrations/routines/${id}/`, { method: "PATCH", body: { prompt } }),
    onSuccess: data => {
      queryClient.setQueryData(routineKey(id), data);
      void queryClient.invalidateQueries({ queryKey: routinesKey(), exact: true });
      setDraft(null);
      toast.success("Instructions saved. The next run uses them.");
    },
    onError: error => toast.error(`Couldn't save instructions: ${errorText(error)}`),
  });
  const run = useMutation({
    mutationFn: () => apiFetch<Routine>(`/api/integrations/routines/${id}/run/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Run queued. Hermes starts it within a minute.");
      void queryClient.invalidateQueries({ queryKey: routineKey(id) });
    },
    onError: error => toast.error(`Couldn't start the run: ${errorText(error)}`),
  });

  const data = routine.data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 max-lg:px-3 py-1.5 border-b border-border/80 bg-background">
        <Button className="h-7 text-[12px] tap-target" size="sm" variant="ghost" render={<Link href="/routines" />}><ArrowLeft className="size-3.5" />Routines</Button>
        <h1 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{data?.name ?? id}</h1>
        <Button className="ml-auto h-7 text-[12px] tap-target" size="sm" variant="ghost" disabled={runs.isFetching} onClick={() => { void routine.refetch(); void runs.refetch(); }}><RefreshCw className="size-3.5" />Refresh</Button>
        <Button className="h-7 text-[12px] tap-target" size="sm" disabled={run.isPending || !data} onClick={() => run.mutate()}><Play className="size-3.5" />Run now</Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-6 p-4">
          {routine.isError && <p role="alert" className="text-sm text-destructive">Couldn’t load this routine from Hermes: {errorText(routine.error)}</p>}
          {data && (
            <dl className="grid gap-3 text-xs sm:grid-cols-4">
              <div><dt className="text-muted-foreground">Schedule</dt><dd className="mt-1 font-mono">{data.schedule_display}</dd></div>
              <div><dt className="text-muted-foreground">State</dt><dd className="mt-1">{data.enabled ? "Enabled" : "Paused"}</dd></div>
              <div><dt className="text-muted-foreground">Next run</dt><dd className="mt-1">{data.enabled ? formatDate(data.next_run_at) : "Paused"}</dd></div>
              <div><dt className="text-muted-foreground">Recap delivered to</dt><dd className="mt-1">{data.deliver === "local" ? "This page only" : data.deliver}</dd></div>
            </dl>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Instructions</h2>
            <Textarea
              aria-label="Instructions"
              className="min-h-40 font-mono text-[13px]"
              value={prompt}
              maxLength={MAX_PROMPT}
              disabled={!data || save.isPending}
              onChange={event => setDraft(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">{prompt.length} / {MAX_PROMPT}</span>
              {draft !== null && <Button className="ml-auto" size="sm" variant="ghost" onClick={() => setDraft(null)}>Discard</Button>}
              <Button className={draft === null ? "ml-auto" : ""} size="sm" disabled={draft === null || draft === data?.prompt || !prompt.trim() || save.isPending} onClick={() => save.mutate()}>Save instructions</Button>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Past runs</h2>
            {runs.isError && <p role="alert" className="text-sm text-destructive">Couldn’t load runs: {errorText(runs.error)}</p>}
            {runs.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading runs…</p> : runs.data?.results.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : runs.data?.results.map(item => (
              <RunRow key={item.session_id ?? item.finished_at} routineId={id} run={item} onRetry={() => run.mutate()} retrying={run.isPending} />
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}

function RunRow({ routineId, run, onRetry, retrying }: { routineId: string; run: RoutineRun; onRetry: () => void; retrying: boolean }) {
  const [open, setOpen] = useState(false);
  const recap = useQuery({
    queryKey: [...routineRunsKey(routineId), run.session_id],
    queryFn: () => apiFetch<{ recap: string; messages: TranscriptMessage[] }>(`/api/integrations/routines/${routineId}/runs/${run.session_id}/`),
    enabled: open && run.session_id !== null,
    staleTime: Infinity,
  });
  return (
    <details className="rounded-lg border bg-card" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3 text-sm">
        <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle(run.status)}`}>{statusLabel(run.status)}</span>
        <span>{formatDate(run.started_at ?? run.finished_at)}</span>
        {run.status === "error" && (
          <Button className="ml-auto h-7 text-[12px]" size="sm" variant="outline" title="Runs the routine again with its current instructions" disabled={retrying} onClick={event => { event.preventDefault(); onRetry(); }}>
            <RotateCcw className="size-3.5" />Retry
          </Button>
        )}
      </summary>
      <div className="space-y-3 border-t p-3 text-sm">
        {run.error && <pre className="whitespace-pre-wrap break-words rounded bg-destructive/5 p-2 text-xs text-destructive">{run.error}</pre>}
        {run.session_id === null ? <p className="text-muted-foreground">Hermes has no stored conversation for this run.</p>
          : recap.isPending ? <p role="status" className="text-muted-foreground">Loading recap…</p>
          : recap.isError ? <p role="alert" className="text-destructive">Couldn’t load the recap: {errorText(recap.error)}</p>
          : <>
            <p className="whitespace-pre-wrap break-words">{recap.data.recap || "This run produced no reply."}</p>
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">Full conversation ({recap.data.messages.length} messages)</summary>
              <ol className="mt-3 space-y-2">
                {recap.data.messages.map((message, index) => <TranscriptItem key={index} message={message} />)}
              </ol>
            </details>
          </>}
      </div>
    </details>
  );
}

const ROLE_LABELS: Record<TranscriptMessage["role"], string> = { user: "Prompt", assistant: "Hermes", tool: "Tool", system: "System" };

function TranscriptItem({ message }: { message: TranscriptMessage }) {
  const label = message.role === "tool" && message.tool_name ? `Tool · ${message.tool_name}` : ROLE_LABELS[message.role] ?? message.role;
  return (
    <li className={`rounded border p-2 text-xs ${message.role === "assistant" ? "bg-card" : "bg-muted/40"}`}>
      <p className="font-medium text-muted-foreground">{label}</p>
      {message.tool_calls.length > 0 && <p className="mt-1 font-mono text-muted-foreground">Called {message.tool_calls.join(", ")}</p>}
      {message.content && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">{message.content}</pre>}
      {message.truncated && <p className="mt-1 text-muted-foreground">Trimmed to the first 4,000 characters.</p>}
    </li>
  );
}
