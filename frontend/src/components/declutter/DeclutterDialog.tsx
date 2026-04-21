"use client";

/**
 * Tinder-style Backlog triage modal.
 *
 * Snapshots the Backlog task ids at open time and walks the user through them
 * one card at a time. Every commit (swipe / key / button) fires a fire-and-
 * forget mutation (move to Todo / move to Done / delete / no-op skip) and
 * advances the cursor after the card's exit animation completes.
 *
 * Scope: when ``scopeProjectId`` is set, only that project's Backlog is
 * triaged; otherwise every project's Backlog is merged into a single queue.
 * Per-task ``Todo`` and ``Done`` columns are resolved by looking up the
 * task's own project — works uniformly across both modes.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Project, Task, TaskListResponse } from "@/lib/types";
import {
  DIRECTION_ACCENT,
  DIRECTION_META,
  DIRECTION_STATUS_ICON,
  SwipeCard,
} from "./SwipeCard";
import type { SwipeDirection } from "@/hooks/use-swipe";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  /** Null = merge backlog across every project; otherwise scope to one. */
  scopeProjectId: number | null;
};

const BACKLOG = "Backlog";
const TODO = "Todo";

type Counters = Record<SwipeDirection, number>;
const ZERO_COUNTERS: Counters = { right: 0, left: 0, up: 0, down: 0 };

type Outgoing = {
  /** Stable id so stale onExitDone callbacks from older outgoings don't
   *  accidentally clear a newer one (defensive; currently only one outgoing
   *  exists at a time, but cheap insurance). */
  id: number;
  task: Task;
  /** Null on the very first render so the card sits at rest, then flipped
   *  to ``targetDir`` one frame later to trigger the CSS transition. */
  dir: SwipeDirection | null;
  targetDir: SwipeDirection;
};

let _outgoingId = 0;
function nextOutgoingId(): number {
  _outgoingId = (_outgoingId + 1) % Number.MAX_SAFE_INTEGER;
  return _outgoingId;
}

export function DeclutterDialog({
  open,
  onOpenChange,
  projects,
  scopeProjectId,
}: Props) {
  const qc = useQueryClient();

  // Bumped by "Load new" to re-snapshot the current Backlog.
  const [sessionKey, setSessionKey] = useState(0);
  const [cursor, setCursor] = useState(0);
  // The card currently flying off-screen (rendered as an absolute overlay on
  // top of the "current" card so the next task is visible immediately). The
  // two-step ``dir`` value is a render trick: we mount with ``dir=null`` so
  // the card sits at rest, then a requestAnimationFrame later flip to
  // ``targetDir`` so the CSS transition has a from→to to interpolate.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const counters = useRef<Counters>({ ...ZERO_COUNTERS });

  // Self-fetch the Backlog scoped to the active project (or all projects).
  // Bypasses the board's paginated cache because triage needs the full
  // column up front, not whichever page happens to be loaded.
  const backlogQuery = useQuery<TaskListResponse>({
    queryKey: ["declutter-tasks", scopeProjectId, sessionKey],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("column", BACKLOG);
      if (scopeProjectId != null) params.set("project", String(scopeProjectId));
      params.set("limit", "500");
      return apiFetch<TaskListResponse>(`/api/tasks/?${params.toString()}`);
    },
    enabled: open,
  });

  const tasks: Task[] = useMemo(
    () => backlogQuery.data?.results ?? [],
    [backlogQuery.data?.results],
  );

  // Snapshot Backlog task ids at open (and on each sessionKey bump).
  // Intentionally omitting ``tasks`` from deps — mid-session re-snapshot
  // would shuffle the deck while the user is triaging. The fetch completes
  // before the dialog becomes interactive for its first frame because the
  // snapshot effect re-runs on the query's first success via sessionKey.
  const queue = useMemo(() => {
    if (!open) return [] as number[];
    return tasks.map((t) => t.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionKey, scopeProjectId, backlogQuery.dataUpdatedAt]);

  // Reset per-session state whenever a fresh session begins.
  useEffect(() => {
    if (!open) return;
    setCursor(0);
    setOutgoing(null);
    setErrorMessage(null);
    counters.current = { ...ZERO_COUNTERS };
  }, [open, sessionKey]);

  // Kick the outgoing card's exit animation one frame after it mounts: we
  // mount with ``dir=null`` (resting), then flip to ``targetDir`` so the
  // CSS transition has a real from→to change to animate.
  useEffect(() => {
    if (!outgoing || outgoing.dir !== null) return;
    const raf = window.requestAnimationFrame(() => {
      setOutgoing((prev) =>
        prev && prev.dir === null && prev.id === outgoing.id
          ? { ...prev, dir: prev.targetDir }
          : prev,
      );
    });
    return () => window.cancelAnimationFrame(raf);
  }, [outgoing]);

  // Local mutation — avoids the project-scoped optimistic logic in
  // ``useMoveTask`` / ``useDeleteTask`` which misses other projects' caches
  // when we're operating across the All-projects view.
  const mutate = useMutation({
    mutationFn: async (v: {
      key: string;
      column_id?: number;
      delete?: boolean;
    }) => {
      if (v.delete) {
        await apiFetch<void>(`/api/tasks/${v.key}/`, { method: "DELETE" });
        return;
      }
      await apiFetch(`/api/tasks/${v.key}/move/`, {
        method: "POST",
        body: { column_id: v.column_id },
      });
    },
    onError: (err) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Something went wrong.",
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["tasks-infinite"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const currentId = queue[cursor];
  const currentTask = useMemo(
    () => (currentId == null ? null : tasks.find((t) => t.id === currentId) ?? null),
    [currentId, tasks],
  );

  const done = cursor >= queue.length;
  const remaining = Math.max(0, queue.length - cursor);

  const commit = useCallback(
    (dir: SwipeDirection) => {
      if (outgoing != null) return; // previous card still animating off
      if (done) return;
      const task = currentTask;
      if (!task) {
        // Stale id — task got deleted / moved concurrently. Just advance.
        setCursor((c) => c + 1);
        return;
      }

      let effectiveDir: SwipeDirection = dir;

      if (dir === "right" || dir === "up") {
        // Lookup target column on the task's own project.
        const proj = projects.find((p) => p.id === task.project);
        const target =
          dir === "right"
            ? proj?.columns.find((c) => c.name === TODO)
            : proj?.columns.find((c) => c.is_done);
        if (!target) {
          setErrorMessage(
            `Can't ${dir === "right" ? "move to Todo" : "move to Done"} — target column not found for project ${
              proj?.prefix ?? "?"
            }. Skipping.`,
          );
          // Treat as a skip — still animate the card out leftward.
          effectiveDir = "left";
        } else {
          mutate.mutate({ key: task.key, column_id: target.id });
        }
      } else if (dir === "down") {
        mutate.mutate({ key: task.key, delete: true });
      }
      // "left" is a skip — no mutation.

      counters.current[effectiveDir] += 1;
      setOutgoing({
        id: nextOutgoingId(),
        task,
        dir: null,
        targetDir: effectiveDir,
      });
      setCursor((c) => c + 1);
    },
    [currentTask, done, mutate, outgoing, projects],
  );

  const handleOutgoingExitDone = useCallback((id: number) => {
    setOutgoing((prev) => (prev && prev.id === id ? null : prev));
  }, []);

  // Keyboard handler — attached via onKeyDown on DialogContent (below)
  // rather than as a window listener, because base-ui's Dialog uses focus
  // trapping that can swallow window-level keydown events. Synthetic events
  // bubble through the React tree from the focused element inside the
  // dialog up to our handler.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      const dir = ARROW_TO_DIR[e.key];
      if (!dir) return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      commit(dir);
    },
    [commit, onOpenChange],
  );

  function reloadSession() {
    setSessionKey((k) => k + 1);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 sm:max-w-3xl w-[92vw] h-[86vh] max-h-[86vh] flex flex-col min-h-0 gap-0 overflow-hidden"
        showCloseButton={false}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="size-4 text-muted-foreground shrink-0" />
            <h2 className="text-[14px] font-semibold tracking-tight truncate">
              Declutter backlog
            </h2>
            {scopeProjectId != null && (
              <span className="text-[11px] text-muted-foreground font-mono">
                {projects.find((p) => p.id === scopeProjectId)?.prefix ?? ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {queue.length > 0 && !done && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {cursor + 1} / {queue.length}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {errorMessage && (
          <div className="shrink-0 flex items-center gap-2 px-5 py-2 text-[12px] bg-destructive/10 text-destructive border-b border-destructive/20">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="flex-1 min-w-0 truncate">{errorMessage}</span>
            <button
              type="button"
              className="text-[11px] underline underline-offset-2 opacity-80 hover:opacity-100"
              onClick={() => setErrorMessage(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Body */}
        {queue.length === 0 ? (
          <EmptyState
            mode="empty"
            counters={counters.current}
            onClose={() => onOpenChange(false)}
            onReload={reloadSession}
          />
        ) : done ? (
          <EmptyState
            mode="done"
            counters={counters.current}
            onClose={() => onOpenChange(false)}
            onReload={reloadSession}
          />
        ) : (
          <SwipeStage
            task={currentTask}
            outgoing={outgoing}
            onCommit={commit}
            onOutgoingExitDone={handleOutgoingExitDone}
            onAdvanceStale={() => setCursor((c) => c + 1)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stage — the card + surrounding arrow buttons
// ---------------------------------------------------------------------------

function SwipeStage({
  task,
  outgoing,
  onCommit,
  onOutgoingExitDone,
  onAdvanceStale,
}: {
  task: Task | null;
  outgoing: Outgoing | null;
  onCommit: (dir: SwipeDirection) => void;
  onOutgoingExitDone: (id: number) => void;
  /** Called when the "current" slot has a stale task id that no longer
   *  exists in ``tasks`` — we advance the cursor silently. */
  onAdvanceStale: () => void;
}) {
  const committing = outgoing != null;
  return (
    <div
      className="flex-1 min-h-0 p-4 grid gap-2"
      style={{
        gridTemplateAreas: `"topSpacer up topSpacer2" "left card right" "botSpacer down botSpacer2"`,
        gridTemplateColumns: "48px minmax(0,1fr) 48px",
        gridTemplateRows: "40px minmax(0,1fr) 40px",
      }}
    >
      <ArrowButton dir="up" onClick={onCommit} disabled={committing} style={{ gridArea: "up" }} />
      <ArrowButton dir="left" onClick={onCommit} disabled={committing} style={{ gridArea: "left" }} />
      <ArrowButton dir="right" onClick={onCommit} disabled={committing} style={{ gridArea: "right" }} />
      <ArrowButton dir="down" onClick={onCommit} disabled={committing} style={{ gridArea: "down" }} />
      <div
        style={{ gridArea: "card" }}
        className="min-h-0 relative flex items-stretch justify-stretch"
      >
        {task ? (
          <SwipeCard
            key={task.id}
            task={task}
            pendingDir={null}
            onCommit={onCommit}
            // The "current" card never actually exits via its own callback
            // — the outgoing overlay handles the exit animation.
            onExitDone={noop}
          />
        ) : queue_tombstone(outgoing) ? (
          <TombstoneCard onAutoAdvance={onAdvanceStale} />
        ) : null}
        {outgoing && (
          <div
            className="absolute inset-0 pointer-events-none"
            aria-hidden
          >
            <SwipeCard
              key={outgoing.id}
              task={outgoing.task}
              pendingDir={outgoing.dir}
              onCommit={noop}
              onExitDone={() => onOutgoingExitDone(outgoing.id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function noop() {}

/** If the current slot has no task but there's no outgoing either, show the
 *  tombstone so the user isn't staring at a blank area. */
function queue_tombstone(outgoing: Outgoing | null): boolean {
  return outgoing == null;
}

function ArrowButton({
  dir,
  onClick,
  disabled,
  style,
}: {
  dir: SwipeDirection;
  onClick: (dir: SwipeDirection) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const { icon: Icon, label } = DIRECTION_META[dir];
  const isHorizontalBar = dir === "up" || dir === "down";
  return (
    <button
      type="button"
      onClick={() => onClick(dir)}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={style}
      className={cn(
        "border border-border bg-background/80 transition-colors",
        "grid place-items-center gap-0",
        "hover:border-foreground/30 disabled:opacity-40 disabled:cursor-not-allowed",
        DIRECTION_ACCENT[dir],
        isHorizontalBar
          ? "h-10 w-full rounded-full"
          : "h-full w-10 mx-auto rounded-full",
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium">
        <Icon className="size-4" />
        {isHorizontalBar && <span>{label}</span>}
      </span>
    </button>
  );
}

function TombstoneCard({
  onAutoAdvance,
}: {
  onAutoAdvance: () => void;
}) {
  useEffect(() => {
    const id = window.setTimeout(onAutoAdvance, 500);
    return () => window.clearTimeout(id);
  }, [onAutoAdvance]);
  return (
    <div className="h-full w-full flex items-center justify-center rounded-xl border border-dashed border-border/60 text-[12px] text-muted-foreground">
      Task no longer available — skipping...
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty + completion state
// ---------------------------------------------------------------------------

function EmptyState({
  mode,
  counters,
  onClose,
  onReload,
}: {
  mode: "empty" | "done";
  counters: Counters;
  onClose: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="size-12 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 grid place-items-center">
        <CheckCircle2 className="size-6" />
      </div>
      <div className="space-y-1">
        <h3 className="text-[16px] font-semibold tracking-tight">
          {mode === "empty"
            ? "Backlog is empty"
            : "Backlog cleared!"}
        </h3>
        <p className="text-[12px] text-muted-foreground">
          {mode === "empty"
            ? "Nothing to triage right now."
            : "Nice work — the queue is done."}
        </p>
      </div>
      {mode === "done" && (
        <div className="flex items-center gap-3 text-[12px]">
          <Stat dir="right" value={counters.right} />
          <Stat dir="up" value={counters.up} />
          <Stat dir="down" value={counters.down} />
          <Stat dir="left" value={counters.left} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" onClick={onReload}>
          Load new tasks
        </Button>
      </div>
    </div>
  );
}

function Stat({ dir, value }: { dir: SwipeDirection; value: number }) {
  const Icon = DIRECTION_STATUS_ICON[dir];
  const { label } = DIRECTION_META[dir];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/80 px-2 py-1",
        "text-[11px]",
      )}
    >
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="font-mono tabular-nums font-semibold">{value}</span>
      <span className="text-muted-foreground">{label.toLowerCase()}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------

const ARROW_TO_DIR: Record<string, SwipeDirection | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};
