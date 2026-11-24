"use client";

/**
 * The open task: activity on the left, the task as a document on the right.
 *
 * Every edit saves itself — property changes immediately, title and
 * description after a short pause (and on close, so nothing typed is lost).
 * Properties are chips; each opens its picker on click or on its key:
 * s status · a assignees · p priority · d deadline · l labels & more ·
 * c comment · j/k next/previous task in the same board column.
 *
 * Create and recurring-template editing still use `TaskPanel`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { CalendarDays, Check, Copy, MoreHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { LinkedPRBadge } from "@/components/integrations/LinkedPRBadge";
import { DescriptionEditor } from "./DescriptionEditor";
import { AssigneeCheckboxList, LabelPicker } from "./pickers";
import { TaskActivity } from "./TaskActivity";
import { TaskSources } from "./TaskSources";
import { formatDuration } from "./TimeInColumn";
import { useBetsQuery } from "@/hooks/use-bets";
import { useLabelsQuery } from "@/hooks/use-labels";
import { useDeleteTask, useMoveTask, useUpdateTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { fetchMe } from "@/lib/auth";
import { currentPeriodStart } from "@/lib/periods";
import { meKey, projectsKey } from "@/lib/query-keys";
import {
  copyTaskId,
  copyTaskPrompt,
  hasTextSelection,
  isEditableElement,
  isPrimaryModifier,
} from "@/lib/task-copy";
import { useTaskDialog } from "@/lib/task-dialog";
import {
  PRIORITY_DOT,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  type BetRef,
  type Priority,
  type Project,
  type Task,
  type TaskListResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// See TaskPanel's CLICK_THROUGH_GUARD_MS (TAS-057): the panel opens under the
// cursor, so the second click of a double-click must not land on it.
const CLICK_THROUGH_GUARD_MS = 400;
const TEXT_SAVE_DELAY_MS = 700;

type Picker = "status" | "assignees" | "priority" | "deadline" | "more";
const PICKER_KEYS: Record<string, Picker> = {
  s: "status",
  a: "assignees",
  p: "priority",
  d: "deadline",
  l: "more",
};

type SaveState = "idle" | "saving" | "saved" | "error";

// Status pill tint per column kind (dot + soft background).
const KIND_TONE: Record<string, { dot: string; pill: string }> = {
  backlog: { dot: "bg-zinc-400", pill: "bg-zinc-500/12" },
  todo: { dot: "bg-sky-500", pill: "bg-sky-500/12" },
  in_progress: { dot: "bg-amber-500", pill: "bg-amber-500/14" },
  waiting: { dot: "bg-violet-500", pill: "bg-violet-500/12" },
  review: { dot: "bg-indigo-500", pill: "bg-indigo-500/12" },
  done: { dot: "bg-emerald-500", pill: "bg-emerald-500/14" },
  cancelled: { dot: "bg-zinc-500", pill: "bg-zinc-500/12" },
  other: { dot: "bg-zinc-400", pill: "bg-zinc-500/12" },
};

/** ↑/↓/Home/End move focus between a picker's rows; Enter/Space pick (they
 *  are buttons). Rows nested in another button (checkbox glyphs) are skipped. */
function listKeys(e: React.KeyboardEvent<HTMLElement>) {
  const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
  if (!(e.key in moves)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")].filter(
    (el) => !el.parentElement?.closest("button"),
  );
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const step = moves[e.key];
  const next =
    step === -Infinity ? 0 : step === Infinity ? rows.length - 1 : (i + step + rows.length) % rows.length;
  rows[next].focus();
}

/** Open a list picker on its current value (else its first row). */
const focusSelected = (picker: string) => () =>
  document.querySelector<HTMLElement>(`[data-picker="${picker}"] [data-selected="true"]`) ?? true;
type Patch = Omit<Parameters<ReturnType<typeof useUpdateTask>["mutate"]>[0], "key">;

export function TaskDetail({
  task,
  projects,
  onClose,
}: {
  task: Task;
  projects: Project[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { openTask } = useTaskDialog();
  const users = useUsersQuery().data ?? [];
  const me = useQuery({ queryKey: meKey(), queryFn: fetchMe }).data ?? null;
  const allLabels = useLabelsQuery().data ?? [];

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [projectId, setProjectId] = useState(task.project);
  const [columnId, setColumnId] = useState(task.column?.id ?? null);
  const [priority, setPriority] = useState(task.priority);
  const [assigneeIds, setAssigneeIds] = useState(task.assignees.map((u) => u.id));
  const [dueAt, setDueAt] = useState(task.due_at ? toLocalInput(task.due_at) : "");
  const [labelIds, setLabelIds] = useState(task.labels.map((l) => l.id));
  const [reviewerId, setReviewerId] = useState(task.reviewer?.id ?? null);
  const [points, setPoints] = useState(task.story_points?.toString() ?? "");
  const [betId, setBetId] = useState(task.bet?.id ?? null);
  const [open, setOpen] = useState<Picker | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const project = projects.find((p) => p.id === projectId) ?? null;
  const columns = useMemo(
    () => (project?.columns ?? []).slice().sort((a, b) => a.order - b.order),
    [project],
  );
  const column = columns.find((c) => c.id === columnId) ?? null;
  const labels = allLabels.filter((l) => labelIds.includes(l.id));
  const availableLabels = allLabels.filter(
    (l) => l.project == null || l.project === projectId,
  );
  const assignees = users.filter((u) => assigneeIds.includes(u.id));
  const reviewer = users.find((u) => u.id === reviewerId) ?? null;

  const betsQuery = useBetsQuery(projectId, currentPeriodStart(), {
    enabled: projectId != null,
  });
  const betOptions = useMemo(() => {
    const bets: BetRef[] = (betsQuery.data ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      status: b.status,
      period_start: b.period_start,
    }));
    if (task.bet && !bets.some((b) => b.id === task.bet!.id)) bets.push(task.bet);
    return bets;
  }, [betsQuery.data, task.bet]);
  const bet = betOptions.find((b) => b.id === betId) ?? null;

  // --- Saving -------------------------------------------------------------
  const updateTask = useUpdateTask();
  const moveTask = useMoveTask();
  const deleteTask = useDeleteTask();

  const saveRef = useRef<(patch: Patch) => void>(() => {});
  // Refreshed after every render, so callers always see this render's state.
  useEffect(() => {
    saveRef.current = (patch) => {
      setSaveState("saving");
      updateTask.mutate(
        { key: task.key, ...patch },
        {
          onSuccess: () => setSaveState("saved"),
          onError: () => setSaveState("error"),
        },
      );
    };
  });
  const save = (patch: Patch) => saveRef.current(patch);

  // Title and description save after a pause; whatever is pending is flushed
  // on close (unmount), on j/k, and on ⌘Enter.
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) saveRef.current(patch);
  }, []);
  const saveLater = (patch: Patch) => {
    Object.assign(pending.current, patch);
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, TEXT_SAVE_DELAY_MS);
  };
  useEffect(() => flush, [flush]);

  // An empty title can't be saved; blur puts the last saved one back.
  const savedTitle = useRef(task.title);
  function changeTitle(value: string) {
    setTitle(value);
    const trimmed = value.trim();
    if (trimmed && trimmed !== savedTitle.current) {
      savedTitle.current = trimmed;
      saveLater({ title: trimmed });
    }
  }

  function changeStatus(id: number) {
    setOpen(null);
    if (id === columnId) return;
    setColumnId(id);
    setSaveState("saving");
    moveTask.mutate(
      { key: task.key, column_id: id },
      {
        onSuccess: () => setSaveState("saved"),
        onError: () => setSaveState("error"),
      },
    );
  }

  function changeProject(id: number | null) {
    if (id === projectId) return;
    const next = projects.find((p) => p.id === id) ?? null;
    const nextColumns = next?.columns ?? [];
    // Keep the same-named column when the new project has one.
    const col =
      nextColumns.find((c) => c.name === column?.name) ??
      nextColumns.find((c) => c.kind === "todo") ??
      nextColumns.find((c) => !c.is_done) ??
      nextColumns[0] ??
      null;
    // Labels scoped to the old project and the bet don't travel.
    const keptLabels = labelIds.filter((lid) => {
      const scope = allLabels.find((l) => l.id === lid)?.project;
      return scope == null || scope === id;
    });
    setProjectId(id);
    setColumnId(col?.id ?? null);
    setLabelIds(keptLabels);
    setBetId(null);
    save({
      project_id: id,
      column_id: col?.id ?? null,
      label_ids: keptLabels,
      bet_id: null,
    });
    void queryClient.invalidateQueries({ queryKey: projectsKey() });
  }

  // --- Keyboard -----------------------------------------------------------
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // j/k walk the board column this task was opened from, in its on-screen
  // order: the cached infinite query that holds the task is that column.
  function neighbour(step: 1 | -1): Task | null {
    const caches = queryClient.getQueriesData<InfiniteData<TaskListResponse>>({
      queryKey: ["tasks-infinite"],
    });
    for (const [, data] of caches) {
      const list = data?.pages.flatMap((p) => p.results) ?? [];
      const i = list.findIndex((t) => t.id === task.id);
      if (i !== -1) return list[i + step] ?? null;
    }
    return null;
  }

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyHandler.current = (e) => {
      if (e.key === "Escape") {
        // A picker or menu closes itself on Escape — and has already done so
        // by the time this window listener runs, so `open` alone can't tell.
        // Skip any Escape that started inside a popup.
        const inPopup = (e.target as Element | null)?.closest?.(
          '[data-slot="popover-content"], [data-slot="dropdown-menu-content"]',
        );
        if (open === null && !inPopup) onClose();
        return;
      }
      if ((e.key === "c" || e.key === "C") && isPrimaryModifier(e) && !e.altKey) {
        if (hasTextSelection() || isEditableElement(document.activeElement)) return;
        e.preventDefault();
        void (e.shiftKey
          ? copyTaskPrompt(task, { title, description })
          : copyTaskId(task));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (open !== null || isEditableElement(document.activeElement)) return;
      const key = e.key.toLowerCase();
      if (PICKER_KEYS[key]) {
        e.preventDefault();
        setOpen(PICKER_KEYS[key]);
      } else if (key === "c") {
        e.preventDefault();
        composerRef.current?.focus();
      } else if (key === "j" || key === "k") {
        const next = neighbour(key === "j" ? 1 : -1);
        if (next) {
          e.preventDefault();
          flush();
          openTask(next);
        }
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- Click-through guard (TAS-057) ----------------------------------------
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = performance.now();
  }, []);
  const guardApplies =
    typeof window === "undefined" ||
    window.matchMedia("(pointer: fine)").matches;
  const guarded = () =>
    guardApplies && performance.now() - openedAt.current < CLICK_THROUGH_GUARD_MS;
  const clickThroughGuard = (e: { preventDefault(): void; stopPropagation(): void }) => {
    if (!guarded()) return;
    e.preventDefault();
    e.stopPropagation();
  };

  async function handleDelete() {
    if (!confirm(`Delete ${task.key}?`)) return;
    await deleteTask.mutateAsync(task.key);
    onClose();
  }

  const pickerProps = (name: Picker) => ({
    open: open === name,
    onOpenChange: (o: boolean) => setOpen(o ? name : null),
  });
  const tone = KIND_TONE[column?.kind ?? "other"] ?? KIND_TONE.other;
  const timeInColumn =
    task.current_column_since && columnId === task.column?.id
      ? formatDuration(task.current_column_since)
      : null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
        onClick={() => {
          if (!guarded()) onClose();
        }}
      />
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-5xl h-[88dvh] lg:mb-4 flex flex-col rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-bottom duration-300 max-lg:h-dvh max-lg:rounded-none max-lg:border-0"
          onPointerDownCapture={clickThroughGuard}
          onMouseDownCapture={clickThroughGuard}
          onClickCapture={clickThroughGuard}
          onDoubleClickCapture={clickThroughGuard}
        >
          {/* Header */}
          <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border/60 max-lg:pt-[max(0.625rem,env(safe-area-inset-top))]">
            {project && (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: project.color }}
              />
            )}
            <span className="text-[12.5px] font-medium truncate">
              {project?.name ?? "Inbox"}
            </span>
            <span className="font-mono text-[11.5px] text-muted-foreground shrink-0">
              {task.key}
            </span>
            <div className="flex-1" />
            <span
              className={cn(
                "text-[11.5px] shrink-0 mr-1",
                saveState === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                  ? "Saved"
                  : saveState === "error"
                    ? "Couldn't save"
                    : ""}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 tap-target"
              title="Copy task ID (⌘C)"
              onClick={() => void copyTaskId(task)}
            >
              <Copy className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 tap-target"
                    title="More"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  onClick={() => void copyTaskPrompt(task, { title, description })}
                >
                  Copy prompt for Claude
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                  Delete task
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 tap-target"
              title="Close (Esc)"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>

          {/* Body: activity left, document right. On mobile one scrolling
              column, document first. */}
          <div className="flex-1 min-h-0 flex max-lg:flex-col max-lg:overflow-y-auto">
            <aside className="w-[320px] shrink-0 min-h-0 flex flex-col border-r border-border/60 max-lg:order-2 max-lg:w-full max-lg:border-r-0 max-lg:border-t pb-safe">
              <TaskActivity
                taskKey={task.key}
                meId={me?.id ?? null}
                linkedPrs={task.linked_prs}
                composerRef={composerRef}
              />
            </aside>

            <main className="group/doc flex-1 min-w-0 min-h-0 flex flex-col px-8 pt-6 pb-4 max-lg:order-1 max-lg:px-4 max-lg:pt-4">
              <input
                value={title}
                onChange={(e) => changeTitle(e.target.value)}
                onBlur={() => {
                  if (!title.trim()) setTitle(savedTitle.current);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="Task title"
                className="shrink-0 w-full bg-transparent text-[22px] font-semibold tracking-tight leading-tight outline-none placeholder:text-muted-foreground/50"
              />

              <div className="shrink-0 flex flex-wrap items-center gap-1.5 mt-3 -ml-2">
                {/* Status */}
                {project && (
                  <Popover {...pickerProps("status")}>
                    <PopoverTrigger
                      render={
                        <Chip
                          hint="S"
                          className={cn("font-medium", tone.pill)}
                        >
                          <span className={cn("size-2 rounded-full", tone.dot)} />
                          {column?.name ?? "No status"}
                          {timeInColumn && (
                            <span className="font-normal text-muted-foreground">
                              {timeInColumn}
                            </span>
                          )}
                        </Chip>
                      }
                    />
                    <PopoverContent
                      align="start"
                      className="w-48 p-1 gap-0"
                      data-picker="status"
                      initialFocus={focusSelected("status")}
                      onKeyDown={listKeys}
                    >
                      {columns.map((c) => (
                        <MenuRow
                          key={c.id}
                          selected={c.id === columnId}
                          onClick={() => changeStatus(c.id)}
                        >
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              (KIND_TONE[c.kind] ?? KIND_TONE.other).dot,
                            )}
                          />
                          {c.name}
                        </MenuRow>
                      ))}
                    </PopoverContent>
                  </Popover>
                )}

                {/* Assignees */}
                <Popover {...pickerProps("assignees")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="A" muted={assignees.length === 0}>
                        {assignees.length === 0 ? (
                          "Assign"
                        ) : (
                          <>
                            <span className="flex -space-x-1.5">
                              {assignees.map((u) => (
                                <UserAvatar
                                  key={u.id}
                                  username={u.username}
                                  avatarUrl={u.avatar_url}
                                  size="size-5"
                                  className="ring-2 ring-card"
                                />
                              ))}
                            </span>
                            {assignees.length === 1 && assignees[0].username}
                          </>
                        )}
                      </Chip>
                    }
                  />
                  <PopoverContent
                    align="start"
                    className="w-52 p-1 gap-0"
                    onKeyDown={listKeys}
                  >
                    <AssigneeCheckboxList
                      available={users}
                      selected={assigneeIds}
                      onToggle={(id) => {
                        const ids = assigneeIds.includes(id)
                          ? assigneeIds.filter((x) => x !== id)
                          : [...assigneeIds, id];
                        setAssigneeIds(ids);
                        save({
                          assignee_ids: ids,
                          optimisticAssignees: users.filter((u) => ids.includes(u.id)),
                        });
                      }}
                    />
                  </PopoverContent>
                </Popover>

                {/* Priority */}
                <Popover {...pickerProps("priority")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="P" muted={!priority}>
                        {priority ? (
                          <>
                            <span className={cn("size-2 rounded-full", PRIORITY_DOT[priority])} />
                            {priority}
                          </>
                        ) : (
                          "Priority"
                        )}
                      </Chip>
                    }
                  />
                  <PopoverContent
                    align="start"
                    className="w-44 p-1 gap-0"
                    data-picker="priority"
                    initialFocus={focusSelected("priority")}
                    onKeyDown={listKeys}
                  >
                    {[...PRIORITY_ORDER, null].map((p) => (
                      <MenuRow
                        key={p ?? "none"}
                        selected={priority === p}
                        onClick={() => {
                          setOpen(null);
                          setPriority(p as Priority | null);
                          save({ priority: p as Priority | null });
                        }}
                      >
                        {p ? (
                          <>
                            <span className={cn("size-2 rounded-full", PRIORITY_DOT[p])} />
                            {PRIORITY_LABELS[p]}
                          </>
                        ) : (
                          <span className="text-muted-foreground">No priority</span>
                        )}
                      </MenuRow>
                    ))}
                  </PopoverContent>
                </Popover>

                {/* Deadline */}
                <Popover {...pickerProps("deadline")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="D" muted={!dueAt}>
                        <CalendarDays className="size-3.5 text-muted-foreground" />
                        {dueAt
                          ? new Date(dueAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })
                          : "Deadline"}
                      </Chip>
                    }
                  />
                  <PopoverContent align="start" className="w-60 p-2 gap-2">
                    <Input
                      type="datetime-local"
                      value={dueAt}
                      onChange={(e) => setDueAt(e.target.value)}
                      onBlur={(e) =>
                        save({
                          due_at: e.target.value
                            ? new Date(e.target.value).toISOString()
                            : null,
                        })
                      }
                      className="h-8 text-[12px]"
                    />
                    {dueAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[12px] justify-start"
                        onClick={() => {
                          setDueAt("");
                          setOpen(null);
                          save({ due_at: null });
                        }}
                      >
                        Clear deadline
                      </Button>
                    )}
                  </PopoverContent>
                </Popover>

                {/* Set extras show as quiet chips; "+ more" edits all of them. */}
                {labels.map((l) => (
                  <span
                    key={l.id}
                    className="inline-flex h-6 items-center rounded-md px-1.5 text-[11.5px]"
                    style={{ background: `${l.color}22`, color: l.color }}
                  >
                    {l.name}
                  </span>
                ))}
                {reviewer && (
                  <span className="inline-flex h-7 items-center gap-1 px-2 text-[12.5px] text-muted-foreground">
                    Review: <span className="text-foreground">{reviewer.username}</span>
                  </span>
                )}
                {points && (
                  <span className="inline-flex h-7 items-center px-2 text-[12.5px] text-muted-foreground">
                    {points} pts
                  </span>
                )}

                <Popover {...pickerProps("more")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="L" muted>
                        + more
                      </Chip>
                    }
                  />
                  <PopoverContent align="start" className="w-72 p-3 gap-3">
                    <Field label="Labels">
                      <LabelPicker
                        available={availableLabels}
                        selected={labelIds}
                        projectId={projectId}
                        onChange={(ids) => {
                          setLabelIds(ids);
                          save({
                            label_ids: ids,
                            optimisticLabels: allLabels.filter((l) => ids.includes(l.id)),
                          });
                        }}
                      />
                    </Field>
                    <Field label="Reviewer">
                      <select
                        value={reviewerId ?? ""}
                        onChange={(e) => {
                          const id = e.target.value ? Number(e.target.value) : null;
                          setReviewerId(id);
                          save({
                            reviewer_id: id,
                            optimisticReviewer: users.find((u) => u.id === id) ?? null,
                          });
                        }}
                        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
                      >
                        <option value="">No reviewer</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Points">
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={points}
                        onChange={(e) => setPoints(e.target.value)}
                        onBlur={() =>
                          save({ story_points: points === "" ? null : Number(points) })
                        }
                        placeholder="—"
                        className="h-8 text-[12px]"
                      />
                    </Field>
                    {project && (
                      <Field label="Bet">
                        <select
                          value={betId ?? ""}
                          onChange={(e) => {
                            const id = e.target.value ? Number(e.target.value) : null;
                            setBetId(id);
                            save({
                              bet_id: id,
                              optimisticBet: betOptions.find((b) => b.id === id) ?? null,
                            });
                          }}
                          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
                        >
                          <option value="">No bet</option>
                          {betOptions.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <Field label="Project">
                      <select
                        value={projectId ?? ""}
                        onChange={(e) =>
                          changeProject(e.target.value ? Number(e.target.value) : null)
                        }
                        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
                      >
                        <option value="">No project (Inbox)</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.prefix})
                          </option>
                        ))}
                      </select>
                    </Field>
                  </PopoverContent>
                </Popover>
              </div>

              {(bet || task.linked_prs.length > 0 || task.sources.length > 0) && (
                <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[12px] text-muted-foreground">
                  {bet && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: bet.color }} />
                      Bet: <span className="text-foreground">{bet.name}</span>
                    </span>
                  )}
                  {task.linked_prs.map((pr) => (
                    <span key={pr.id} className="inline-flex items-center gap-1.5 min-w-0">
                      <LinkedPRBadge pr={pr} />
                      <span className="truncate max-w-64">{pr.pr_title}</span>
                    </span>
                  ))}
                  <TaskSources sources={task.sources} />
                </div>
              )}

              <div className="flex-1 min-h-0 mt-2 max-lg:flex-none max-lg:min-h-[45dvh]">
                <DescriptionEditor
                  plain
                  value={description}
                  onChange={(v) => {
                    setDescription(v);
                    saveLater({ description: v });
                  }}
                  onSubmit={flush}
                />
              </div>

              <div className="shrink-0 flex flex-wrap gap-x-3 gap-y-1 pt-3 text-[11px] text-muted-foreground/70 max-lg:hidden">
                <KeyHint k="S">status</KeyHint>
                <KeyHint k="A">assign</KeyHint>
                <KeyHint k="P">priority</KeyHint>
                <KeyHint k="D">deadline</KeyHint>
                <KeyHint k="L">more</KeyHint>
                <KeyHint k="C">comment</KeyHint>
                <KeyHint k="J K">next / prev</KeyHint>
                <KeyHint k="⌘K">all actions</KeyHint>
              </div>
            </main>
          </div>
        </div>
      </div>
    </>
  );
}

/** A property chip. Its shortcut key fades in while the pointer is over the
 *  document, so the keys are learnable without being permanently visible. */
function Chip({
  hint,
  muted,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { hint: string; muted?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-accent",
        muted && "text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <kbd className="pointer-events-none absolute -top-1.5 -right-1 rounded border border-border bg-card px-1 font-mono text-[9px] leading-[14px] text-muted-foreground opacity-0 transition-opacity group-hover/doc:opacity-100 hover-none:hidden">
        {hint}
      </kbd>
    </button>
  );
}

function MenuRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-selected={selected}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent focus-visible:bg-accent outline-none"
    >
      {children}
      {selected && <Check className="ml-auto size-3.5 text-muted-foreground" />}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function KeyHint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {k.split(" ").map((part) => (
        <kbd
          key={part}
          className="rounded border border-border px-1 font-mono text-[10px]"
        >
          {part}
        </kbd>
      ))}
      {children}
    </span>
  );
}

/** ISO timestamp → the local "YYYY-MM-DDTHH:mm" a datetime-local input wants. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
