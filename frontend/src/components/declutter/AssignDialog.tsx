"use client";

/**
 * Tinder-style Todo-column triage modal for assigning tasks to users.
 *
 * Each user can be bound to any keyboard key (letter, digit, punctuation,
 * arrow key) via ``preferences.assign_hotkey_bindings`` on
 * ``/api/auth/me/``. Binding is user-private. Pressing a bound key — or
 * clicking the user's chip — assigns the current task to that user
 * (replacing any existing assignees) and advances. Down-arrow / down-swipe
 * skips; other swipe directions are no-ops.
 *
 * Reserved keys that can never be bound: ``ArrowDown`` (skip) and
 * ``Escape`` (close dialog). Modifier-only presses (``Ctrl``/``Cmd``/etc.)
 * are also rejected so browser shortcuts keep working.
 *
 * Scope mirrors ``DeclutterDialog``: ``scopeProjectId`` null merges Todo
 * across every project; otherwise scopes to one.
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
import {
  AlertTriangle,
  CheckCircle2,
  Settings2,
  UserPlus,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { Me, Project, Task, TaskListResponse, User } from "@/lib/types";
import { SwipeCard } from "./SwipeCard";
import type { SwipeDirection } from "@/hooks/use-swipe";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  users: User[];
  /** Null = merge Todo across every project; otherwise scope to one. */
  scopeProjectId: number | null;
};

const TODO = "Todo";
/** Columns that count toward a user's "active load" in the hotkey bar. */
const ACTIVE_COLUMNS = new Set(["Todo", "In Progress", "In Review"]);

/** Keys the dialog owns for other behaviors — never bindable. */
const RESERVED_KEYS = new Set<string>(["ArrowDown", "Escape"]);

type Outgoing = {
  id: number;
  task: Task;
  dir: SwipeDirection | null;
  targetDir: SwipeDirection;
};

let _outgoingId = 0;
function nextOutgoingId(): number {
  _outgoingId = (_outgoingId + 1) % Number.MAX_SAFE_INTEGER;
  return _outgoingId;
}

/** Normalize a KeyboardEvent into the string we store. Letters -> uppercase
 *  single char; arrow keys pass through; everything else that's a single
 *  printable char passes through as-is. Returns null if the key can't be
 *  bound (modifier combo, reserved, modifier-only, unsupported). */
function normalizeKey(e: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (RESERVED_KEYS.has(e.key)) return null;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp") {
    return e.key;
  }
  if (e.key.length !== 1) return null;
  // Upper-case letters so "a" and "A" converge on the same binding. Digits
  // and punctuation are already case-invariant so this is a no-op for them.
  return e.key.toUpperCase();
}

/** Pretty form for display — arrows as glyphs, Space as the word. */
function formatKey(key: string): string {
  switch (key) {
    case "ArrowLeft":
      return "\u2190";
    case "ArrowRight":
      return "\u2192";
    case "ArrowUp":
      return "\u2191";
    case " ":
      return "Space";
    default:
      return key;
  }
}

export function AssignDialog({
  open,
  onOpenChange,
  projects,
  users,
  scopeProjectId,
}: Props) {
  const qc = useQueryClient();

  const [sessionKey, setSessionKey] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const assignedCount = useRef(0);
  const skippedCount = useRef(0);

  // Pull both Todo (the triage queue) and the adjacent active columns (used
  // by ``loadByUser`` to render the "active load" badge) in one request, so
  // the dialog doesn't depend on the board's paginated cache.
  const todoQuery = useQuery<TaskListResponse>({
    queryKey: ["assign-tasks", scopeProjectId, sessionKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (scopeProjectId != null) params.set("project", String(scopeProjectId));
      // Fetch all active-column tasks in one pass by omitting ``column`` —
      // we filter in memory below. Kept generous for dialog purposes.
      params.set("limit", "500");
      return apiFetch<TaskListResponse>(`/api/tasks/?${params.toString()}`);
    },
    enabled: open,
  });

  const tasks: Task[] = useMemo(
    () => todoQuery.data?.results ?? [],
    [todoQuery.data?.results],
  );

  // /api/auth/me/ carries this user's personal hotkey bindings under
  // ``preferences.assign_hotkey_bindings``. Re-use the same cache key Shell
  // seeds on boot so we don't double-fetch.
  const meQuery = useQuery({
    queryKey: meKey(),
    queryFn: fetchMe,
  });
  // Memoize so a fresh ``{}`` fallback doesn't spuriously invalidate
  // downstream memos on every render.
  const bindings = useMemo(
    () => meQuery.data?.preferences?.assign_hotkey_bindings ?? {},
    [meQuery.data?.preferences?.assign_hotkey_bindings],
  );

  // Snapshot Todo task ids at open. Intentionally omitting ``tasks`` from
  // deps — mid-session re-snapshot would shuffle the deck while the user
  // is triaging. The snapshot refreshes when ``dataUpdatedAt`` advances,
  // which covers both the initial fetch and explicit "Load new" refreshes.
  const queue = useMemo(() => {
    if (!open) return [] as number[];
    return tasks
      .filter((t) => t.column?.name === TODO)
      .filter((t) => scopeProjectId == null || t.project === scopeProjectId)
      .map((t) => t.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionKey, scopeProjectId, todoQuery.dataUpdatedAt]);

  // Display order in the hotkey bar is always alphabetical — binding is
  // what matters for speed, so reordering by binding would just force the
  // user to re-scan every session. Chips without a binding are still
  // rendered and still clickable.
  const displayUsers = useMemo(
    () => [...users].sort((a, b) => a.username.localeCompare(b.username)),
    [users],
  );

  // Drop bindings that point at vanished users or at reserved keys (the
  // backend already filters these, but defend against stale cache too).
  const userByKey = useMemo(() => {
    const userIds = new Set(users.map((u) => u.id));
    const byId = new Map(users.map((u) => [u.id, u] as const));
    const out: Record<string, User> = {};
    for (const [k, uid] of Object.entries(bindings)) {
      if (RESERVED_KEYS.has(k)) continue;
      if (!userIds.has(uid)) continue;
      const u = byId.get(uid);
      if (u) out[k] = u;
    }
    return out;
  }, [bindings, users]);

  // Inverse lookup for rendering each chip's key badge.
  const keyByUserId = useMemo(() => {
    const out = new Map<number, string>();
    for (const [k, u] of Object.entries(userByKey)) {
      out.set(u.id, k);
    }
    return out;
  }, [userByKey]);

  // Per-user active-load count. Updates live as ``tasks`` refetches, so the
  // bar reflects assignments made earlier in the session.
  const loadByUser = useMemo(() => {
    const map = new Map<number, number>();
    for (const t of tasks) {
      if (!t.column || !ACTIVE_COLUMNS.has(t.column.name)) continue;
      if (scopeProjectId != null && t.project !== scopeProjectId) continue;
      for (const a of t.assignees) {
        map.set(a.id, (map.get(a.id) ?? 0) + 1);
      }
    }
    return map;
  }, [tasks, scopeProjectId]);

  useEffect(() => {
    if (!open) return;
    setCursor(0);
    setOutgoing(null);
    setErrorMessage(null);
    assignedCount.current = 0;
    skippedCount.current = 0;
  }, [open, sessionKey]);

  // Kick the outgoing card's exit one frame after mount so the CSS
  // transition has a from→to to interpolate.
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

  const mutate = useMutation({
    mutationFn: async (v: { key: string; assigneeId: number }) => {
      await apiFetch(`/api/tasks/${v.key}/`, {
        method: "PATCH",
        body: { assignee_ids: [v.assigneeId] },
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
    () =>
      currentId == null ? null : tasks.find((t) => t.id === currentId) ?? null,
    [currentId, tasks],
  );

  const done = cursor >= queue.length;

  const assignTo = useCallback(
    (user: User) => {
      if (outgoing != null) return;
      if (done) return;
      const task = currentTask;
      if (!task) {
        setCursor((c) => c + 1);
        return;
      }
      mutate.mutate({ key: task.key, assigneeId: user.id });
      assignedCount.current += 1;
      setOutgoing({
        id: nextOutgoingId(),
        task,
        dir: null,
        targetDir: "right",
      });
      setCursor((c) => c + 1);
    },
    [currentTask, done, mutate, outgoing],
  );

  const skip = useCallback(() => {
    if (outgoing != null) return;
    if (done) return;
    const task = currentTask;
    if (!task) {
      setCursor((c) => c + 1);
      return;
    }
    skippedCount.current += 1;
    setOutgoing({
      id: nextOutgoingId(),
      task,
      dir: null,
      targetDir: "down",
    });
    setCursor((c) => c + 1);
  }, [currentTask, done, outgoing]);

  const handleOutgoingExitDone = useCallback((id: number) => {
    setOutgoing((prev) => (prev && prev.id === id ? null : prev));
  }, []);

  // Only "down" drag-swipes commit a skip. Up / Left / Right drags are
  // ignored — card snaps back to center and the user can try a letter.
  const handleCardSwipe = useCallback(
    (dir: SwipeDirection) => {
      if (dir === "down") skip();
    },
    [skip],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        skip();
        return;
      }
      const normalized = normalizeKey(e);
      if (!normalized) return;
      const user = userByKey[normalized];
      if (user) {
        e.preventDefault();
        e.stopPropagation();
        assignTo(user);
      }
    },
    [assignTo, onOpenChange, skip, userByKey],
  );

  function reloadSession() {
    setSessionKey((k) => k + 1);
  }

  const projectLabel =
    scopeProjectId != null
      ? projects.find((p) => p.id === scopeProjectId)?.prefix ?? ""
      : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 sm:max-w-3xl w-[92vw] h-[86vh] max-h-[86vh] flex flex-col min-h-0 gap-0 overflow-hidden"
        showCloseButton={false}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <UserPlus className="size-4 text-muted-foreground shrink-0" />
            <h2 className="text-[14px] font-semibold tracking-tight truncate">
              Assign Todo
            </h2>
            {projectLabel && (
              <span className="text-[11px] text-muted-foreground font-mono">
                {projectLabel}
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
              onClick={() => setCustomizeOpen(true)}
              aria-label="Customize hotkeys"
              title="Customize hotkeys"
            >
              <Settings2 className="size-4" />
            </Button>
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

        {queue.length === 0 ? (
          <EmptyState
            mode="empty"
            assigned={assignedCount.current}
            skipped={skippedCount.current}
            onClose={() => onOpenChange(false)}
            onReload={reloadSession}
          />
        ) : done ? (
          <EmptyState
            mode="done"
            assigned={assignedCount.current}
            skipped={skippedCount.current}
            onClose={() => onOpenChange(false)}
            onReload={reloadSession}
          />
        ) : (
          <>
            <div className="flex-1 min-h-0 p-4 relative flex items-stretch justify-stretch">
              {currentTask && (
                <SwipeCard
                  key={currentTask.id}
                  task={currentTask}
                  pendingDir={null}
                  onCommit={handleCardSwipe}
                  onExitDone={noop}
                />
              )}
              {outgoing && (
                <div className="absolute inset-4 pointer-events-none">
                  <SwipeCard
                    key={outgoing.id}
                    task={outgoing.task}
                    pendingDir={outgoing.dir}
                    onCommit={noop}
                    onExitDone={() => handleOutgoingExitDone(outgoing.id)}
                  />
                </div>
              )}
            </div>

            <UserHotkeyBar
              users={displayUsers}
              keyByUserId={keyByUserId}
              loadByUser={loadByUser}
              disabled={outgoing != null}
              onAssign={assignTo}
            />
          </>
        )}
      </DialogContent>
      <CustomizeHotkeysDialog
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        allUsers={users}
        bindings={bindings}
      />
    </Dialog>
  );
}

function noop() {}

// ---------------------------------------------------------------------------

function UserHotkeyBar({
  users,
  keyByUserId,
  loadByUser,
  disabled,
  onAssign,
}: {
  users: User[];
  keyByUserId: Map<number, string>;
  loadByUser: Map<number, number>;
  disabled: boolean;
  onAssign: (u: User) => void;
}) {
  return (
    <div className="shrink-0 border-t border-border/60 bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto scrollbar-none">
        {users.length === 0 ? (
          <span className="text-[12px] text-muted-foreground px-2 py-1">
            No users available.
          </span>
        ) : (
          users.map((u) => {
            const bound = keyByUserId.get(u.id) ?? null;
            const load = loadByUser.get(u.id) ?? 0;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onAssign(u)}
                disabled={disabled}
                title={
                  bound
                    ? `Assign to ${u.username} — press ${formatKey(bound)}`
                    : `Assign to ${u.username} (no hotkey set)`
                }
                className={cn(
                  "shrink-0 flex items-center gap-2 rounded-md border border-border/70 bg-background px-2 py-1.5",
                  "hover:border-foreground/40 hover:bg-accent transition-colors",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                {bound ? (
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded bg-muted text-[11px] font-mono font-semibold tabular-nums">
                    {formatKey(bound)}
                  </span>
                ) : (
                  <span className="inline-flex items-center justify-center size-5 rounded border border-dashed border-border text-[10px] font-mono text-muted-foreground/70">
                    &middot;
                  </span>
                )}
                <UserAvatar
                  username={u.username}
                  avatarUrl={u.avatar_url}
                  size="size-5"
                />
                <span className="text-[12px] font-medium truncate max-w-[120px]">
                  {u.username}
                </span>
                <LoadPill count={load} />
              </button>
            );
          })
        )}
      </div>
      <div className="px-3 pb-2 text-[10.5px] text-muted-foreground">
        Press your bound key to assign ·{" "}
        <kbd className="font-mono">↓</kbd> to skip ·{" "}
        <kbd className="font-mono">Esc</kbd> to close
      </div>
    </div>
  );
}

function LoadPill({ count }: { count: number }) {
  const color =
    count === 0
      ? "bg-muted text-muted-foreground"
      : count <= 2
        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        : count <= 5
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-red-500/15 text-red-600 dark:text-red-400";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-mono tabular-nums font-semibold",
        color,
      )}
    >
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------

function EmptyState({
  mode,
  assigned,
  skipped,
  onClose,
  onReload,
}: {
  mode: "empty" | "done";
  assigned: number;
  skipped: number;
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
          {mode === "empty" ? "Todo is empty" : "All assigned!"}
        </h3>
        <p className="text-[12px] text-muted-foreground">
          {mode === "empty"
            ? "Nothing in Todo to assign right now."
            : "Nice work — the Todo column is triaged."}
        </p>
      </div>
      {mode === "done" && (
        <div className="flex items-center gap-3 text-[12px]">
          <Stat value={assigned} label="assigned" />
          <Stat value={skipped} label="skipped" />
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

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 px-2 py-1 text-[11px]">
      <span className="font-mono tabular-nums font-semibold">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Customize hotkeys — per-user arbitrary key bindings
// ---------------------------------------------------------------------------

/** How long the "this user just lost their binding" flash lingers. */
const CONFLICT_FLASH_MS = 1600;

function CustomizeHotkeysDialog({
  open,
  onOpenChange,
  allUsers,
  bindings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allUsers: User[];
  /** Current persisted bindings. Used to seed the draft each time the
   *  dialog opens so cancelling discards any local edits. */
  bindings: Record<string, number>;
}) {
  const qc = useQueryClient();

  // Draft lives as userId -> key (inverse of the server shape) because
  // every row in the UI is "for user X, what's their key?" — so lookups
  // during render are O(1). We rebuild the key->user shape at save time.
  const seedDraft = useCallback(() => {
    const byUser: Record<number, string> = {};
    for (const [k, uid] of Object.entries(bindings)) {
      if (RESERVED_KEYS.has(k)) continue;
      byUser[uid] = k;
    }
    return byUser;
  }, [bindings]);

  const [draft, setDraft] = useState<Record<number, string>>(seedDraft);
  const [capturingUserId, setCapturingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flashUserId, setFlashUserId] = useState<number | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);

  // Render-time "previous-open" pattern: reseed every time the dialog
  // opens so the last successful save is always the starting point.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setDraft(seedDraft());
      setCapturingUserId(null);
      setError(null);
      setFlashUserId(null);
    }
  }

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current != null) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  const sortedUsers = useMemo(
    () => [...allUsers].sort((a, b) => a.username.localeCompare(b.username)),
    [allUsers],
  );

  const mutation = useMutation({
    mutationFn: async (byUser: Record<number, string>) => {
      // Invert to key -> userId for storage. Drops empty entries.
      const payload: Record<string, number> = {};
      for (const [uid, k] of Object.entries(byUser)) {
        if (!k) continue;
        payload[k] = Number(uid);
      }
      return apiFetch<Me>("/api/auth/me/", {
        method: "PATCH",
        body: { preferences: { assign_hotkey_bindings: payload } },
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(meKey(), data);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Save failed.");
    },
  });

  function flashUser(uid: number) {
    setFlashUserId(uid);
    if (flashTimeoutRef.current != null) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashUserId(null);
      flashTimeoutRef.current = null;
    }, CONFLICT_FLASH_MS);
  }

  function bindKeyTo(userId: number, normalized: string) {
    // Overwrite silently: find anyone currently holding this key and
    // strip them. Flash that user's row so the displacement is visible.
    const next: Record<number, string> = { ...draft };
    let displaced: number | null = null;
    for (const [uidStr, existingKey] of Object.entries(next)) {
      const uid = Number(uidStr);
      if (existingKey === normalized && uid !== userId) {
        delete next[uid];
        displaced = uid;
        break;
      }
    }
    next[userId] = normalized;
    setDraft(next);
    setCapturingUserId(null);
    setError(null);
    if (displaced != null) flashUser(displaced);
  }

  function clearBinding(userId: number) {
    const next = { ...draft };
    delete next[userId];
    setDraft(next);
  }

  function clearAll() {
    setDraft({});
    setCapturingUserId(null);
  }

  // Keys handled at the document level while a row is in capture mode —
  // can't rely on per-row onKeyDown because not every key reliably targets
  // a button's focus (arrow keys often get swallowed by the browser).
  useEffect(() => {
    if (capturingUserId == null) return;
    const uid = capturingUserId;
    function onKey(e: KeyboardEvent) {
      // Escape: bail out of capture without binding anything.
      if (e.key === "Escape") {
        e.preventDefault();
        setCapturingUserId(null);
        return;
      }
      const normalized = normalizeKey(e);
      if (!normalized) {
        // Give the user a specific reason so the rejection isn't silent.
        if (RESERVED_KEYS.has(e.key)) {
          setError(`"${formatKey(e.key)}" is reserved.`);
        } else if (e.metaKey || e.ctrlKey || e.altKey) {
          setError("Modifier-key combos can't be bound.");
        } else {
          setError(`Key "${e.key}" isn't bindable — try a letter or arrow.`);
        }
        e.preventDefault();
        return;
      }
      e.preventDefault();
      bindKeyTo(uid, normalized);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // bindKeyTo closes over draft, but we want the latest draft each time —
    // reading through the setter callback inside bindKeyTo keeps it fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingUserId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 sm:max-w-md w-[92vw] max-h-[80vh] flex flex-col min-h-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <Settings2 className="size-4 text-muted-foreground shrink-0" />
            <h2 className="text-[14px] font-semibold tracking-tight truncate">
              Customize hotkeys
            </h2>
          </div>
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

        <p className="shrink-0 px-5 pt-3 pb-1 text-[12px] text-muted-foreground">
          Click a user&apos;s key slot, then press any key — letter, digit, or
          arrow. <kbd className="font-mono">↓</kbd> and{" "}
          <kbd className="font-mono">Esc</kbd> are reserved.
        </p>

        {error && (
          <div className="shrink-0 flex items-center gap-2 px-5 py-2 text-[12px] bg-destructive/10 text-destructive border-b border-destructive/20">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="flex-1 min-w-0 truncate">{error}</span>
            <button
              type="button"
              className="text-[11px] underline underline-offset-2 opacity-80 hover:opacity-100"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1">
          {sortedUsers.length === 0 && (
            <div className="text-[12px] text-muted-foreground px-2 py-4 text-center">
              No users available.
            </div>
          )}
          {sortedUsers.map((u) => {
            const bound = draft[u.id];
            const isCapturing = capturingUserId === u.id;
            const isFlashing = flashUserId === u.id;
            return (
              <div
                key={u.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors",
                  isFlashing
                    ? "border-amber-500/60 bg-amber-500/10"
                    : "border-border/70 bg-background",
                )}
              >
                <UserAvatar
                  username={u.username}
                  avatarUrl={u.avatar_url}
                  size="size-5"
                />
                <span className="flex-1 min-w-0 text-[12px] font-medium truncate">
                  {u.username}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setCapturingUserId((prev) => (prev === u.id ? null : u.id))
                  }
                  className={cn(
                    "inline-flex items-center justify-center min-w-16 h-7 px-2 rounded border text-[11px] font-mono font-semibold tabular-nums transition-colors",
                    isCapturing
                      ? "border-foreground/60 bg-accent animate-pulse"
                      : bound
                        ? "border-border bg-muted hover:border-foreground/40"
                        : "border-dashed border-border/60 text-muted-foreground hover:border-foreground/40",
                  )}
                  aria-label={
                    bound
                      ? `Change hotkey for ${u.username}`
                      : `Set hotkey for ${u.username}`
                  }
                  title={
                    isCapturing
                      ? "Press any key..."
                      : bound
                        ? `Bound to ${formatKey(bound)}. Click to rebind.`
                        : "Click, then press any key"
                  }
                >
                  {isCapturing ? "Press key..." : bound ? formatKey(bound) : "Set key"}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  disabled={!bound || isCapturing}
                  onClick={() => clearBinding(u.id)}
                  aria-label={`Clear hotkey for ${u.username}`}
                  title="Clear binding"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-t border-border/60">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={mutation.isPending || Object.keys(draft).length === 0}
          >
            Clear all
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => mutation.mutate(draft)}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
