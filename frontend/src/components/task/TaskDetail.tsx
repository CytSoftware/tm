"use client";

/**
 * The task panel for creating and editing a task: activity on the left, the
 * task as a document on the right, every property a chip.
 *
 * Editing saves itself — property changes immediately, title and description
 * after a short pause (and on close, so nothing typed is lost). Creating keeps
 * everything local until ⌘Enter or the Create button.
 *
 * Each chip opens its picker on click or on its key (see PICKER_KEYS); c
 * focuses the comment box and j/k walk the board column. Recurring templates
 * are still edited in `TaskPanel`.
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
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  Copy,
  FolderOpen,
  MoreHorizontal,
  Repeat,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { AssigneeCheckboxList, LabelMenu } from "./pickers";
import {
  RecurrencePicker,
  buildRrule,
  type RecurrenceState,
} from "./RecurrencePicker";
import { TaskActivity } from "./TaskActivity";
import { TaskSources } from "./TaskSources";
import { formatDuration } from "./TimeInColumn";
import { useBetsQuery } from "@/hooks/use-bets";
import { useLabelsQuery } from "@/hooks/use-labels";
import {
  useCreateTask,
  useDeleteTask,
  useMoveTask,
  useUpdateTask,
} from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { apiFetch } from "@/lib/api";
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
  type Column,
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

type Picker =
  | "status"
  | "assignees"
  | "priority"
  | "deadline"
  | "labels"
  | "reviewer"
  | "points"
  | "bet"
  | "project"
  | "repeat";
const PICKER_KEYS: Record<string, Picker> = {
  s: "status",
  a: "assignees",
  p: "priority",
  d: "deadline",
  l: "labels",
  r: "reviewer",
  e: "points",
  b: "bet",
};

type SaveState = "idle" | "saving" | "saved" | "error";
type Patch = Omit<Parameters<ReturnType<typeof useUpdateTask>["mutate"]>[0], "key">;

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
  const moves: Record<string, number> = {
    ArrowDown: 1,
    ArrowUp: -1,
    Home: -Infinity,
    End: Infinity,
  };
  if (!(e.key in moves)) return;
  const rows = [
    ...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"),
  ].filter((el) => !el.parentElement?.closest("button"));
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const step = moves[e.key];
  const next =
    step === -Infinity
      ? 0
      : step === Infinity
        ? rows.length - 1
        : (i + step + rows.length) % rows.length;
  rows[next].focus();
}

/** Open a list picker on its current value (else its first row). */
const focusSelected = (picker: Picker) => () =>
  document.querySelector<HTMLElement>(
    `[data-picker="${picker}"] [data-selected="true"]`,
  ) ?? true;

/** A new task lands in the column it was created from, else the first Todo. */
function defaultColumn(project: Project | null, preferredId: number | null) {
  const cols = project?.columns ?? [];
  return (
    cols.find((c) => c.id === preferredId) ??
    cols.find((c) => c.kind === "todo") ??
    cols.find((c) => !c.is_done) ??
    cols[0] ??
    null
  );
}

export function TaskDetail({
  task,
  create,
  projects,
  onClose,
}: {
  projects: Project[];
  onClose: () => void;
} & (
  | { task: Task; create?: never }
  | { task?: never; create: { projectId: number | null; columnId: number | null } }
)) {
  const isNew = !task;
  const queryClient = useQueryClient();
  const { openTask } = useTaskDialog();
  const users = useUsersQuery().data ?? [];
  const me = useQuery({ queryKey: meKey(), queryFn: fetchMe }).data ?? null;
  const allLabels = useLabelsQuery().data ?? [];

  const startProject = task
    ? task.project
    : (projects.find((p) => p.id === create.projectId)?.id ?? null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [projectId, setProjectId] = useState<number | null>(startProject);
  const [columnId, setColumnId] = useState<number | null>(
    task
      ? (task.column?.id ?? null)
      : (defaultColumn(
          projects.find((p) => p.id === startProject) ?? null,
          create.columnId,
        )?.id ?? null),
  );
  const [priority, setPriority] = useState<Priority | null>(task?.priority ?? null);
  const [assigneeIds, setAssigneeIds] = useState(
    task?.assignees.map((u) => u.id) ?? [],
  );
  const [dueAt, setDueAt] = useState(task?.due_at ? toLocalInput(task.due_at) : "");
  const [labelIds, setLabelIds] = useState(task?.labels.map((l) => l.id) ?? []);
  const [reviewerId, setReviewerId] = useState<number | null>(task?.reviewer?.id ?? null);
  const [points, setPoints] = useState(task?.story_points?.toString() ?? "");
  const [betId, setBetId] = useState<number | null>(task?.bet?.id ?? null);
  const [recurrence, setRecurrence] = useState<RecurrenceState>(() => ({
    enabled: false,
    preset: "daily",
    weekdays: ["MO"],
    monthDay: 1,
    customRrule: "",
    dtstartLocal: nextHourLocal(),
  }));
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
  const ownBet = task?.bet ?? null;
  const betOptions = useMemo(() => {
    const bets: BetRef[] = (betsQuery.data ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      status: b.status,
      period_start: b.period_start,
    }));
    // The task's own bet stays selectable even from an older period.
    if (ownBet && !bets.some((b) => b.id === ownBet.id)) bets.push(ownBet);
    return bets;
  }, [betsQuery.data, ownBet]);
  const bet = betOptions.find((b) => b.id === betId) ?? null;

  // --- Saving (edit) ------------------------------------------------------
  const updateTask = useUpdateTask();
  const moveTask = useMoveTask();
  const deleteTask = useDeleteTask();

  const saveRef = useRef<(patch: Patch) => void>(() => {});
  // Refreshed after every render, so callers always see this render's state.
  useEffect(() => {
    saveRef.current = (patch) => {
      if (!task) return; // a new task is sent whole on Create
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
    if (isNew) return;
    Object.assign(pending.current, patch);
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, TEXT_SAVE_DELAY_MS);
  };
  useEffect(() => flush, [flush]);

  // An empty title can't be saved; blur puts the last saved one back.
  const savedTitle = useRef(task?.title ?? "");
  function changeTitle(value: string) {
    setTitle(value);
    const trimmed = value.trim();
    if (!isNew && trimmed && trimmed !== savedTitle.current) {
      savedTitle.current = trimmed;
      saveLater({ title: trimmed });
    }
  }

  function changeStatus(id: number) {
    setOpen(null);
    if (id === columnId) return;
    setColumnId(id);
    if (!task) return;
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
    setOpen(null);
    if (id === projectId) return;
    const col = defaultColumn(projects.find((p) => p.id === id) ?? null, null);
    // Keep the same-named column when the new project has one.
    const sameName =
      projects
        .find((p) => p.id === id)
        ?.columns.find((c) => c.name === column?.name) ?? col;
    // Labels scoped to the old project and the bet don't travel.
    const keptLabels = labelIds.filter((lid) => {
      const scope = allLabels.find((l) => l.id === lid)?.project;
      return scope == null || scope === id;
    });
    setProjectId(id);
    setColumnId(sameName?.id ?? null);
    setLabelIds(keptLabels);
    setBetId(null);
    if (id == null) setRecurrence((r) => ({ ...r, enabled: false }));
    save({
      project_id: id,
      column_id: sameName?.id ?? null,
      label_ids: keptLabels,
      bet_id: null,
    });
    if (!isNew) void queryClient.invalidateQueries({ queryKey: projectsKey() });
  }

  // --- Creating -----------------------------------------------------------
  const createTask = useCreateTask();
  const createRecurring = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch("/api/recurring-tasks/", { method: "POST", body: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["recurring"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks-infinite"] });
    },
  });
  const creating = createTask.isPending || createRecurring.isPending;
  const canCreate = isNew && !!title.trim() && !creating;

  // ⌘Enter in the description reaches both the editor's onSubmit and the
  // window listener; this ref stops the second call creating a duplicate.
  const submitting = useRef(false);
  async function createNow() {
    if (!canCreate || submitting.current) return;
    submitting.current = true;
    const shared = {
      title: title.trim(),
      description,
      priority,
      story_points: points === "" ? null : Number(points),
      assignee_ids: assigneeIds,
      label_ids: labelIds,
    };
    try {
      if (recurrence.enabled) {
        const rrule = buildRrule(recurrence);
        if (!project || !rrule || !recurrence.dtstartLocal) {
          submitting.current = false;
          return;
        }
        await createRecurring.mutateAsync({
          ...shared,
          project_id: project.id,
          column_id: columnId,
          rrule,
          dtstart: new Date(recurrence.dtstartLocal).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
          active: true,
        });
      } else {
        await createTask.mutateAsync({
          ...shared,
          project_id: projectId,
          column_id: project ? columnId : null,
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
          bet_id: project ? betId : null,
          reviewer_id: reviewerId,
        });
      }
      onClose();
    } catch {
      submitting.current = false;
      setSaveState("error");
    }
  }

  // --- Keyboard -----------------------------------------------------------
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // j/k walk the board column this task was opened from, in its on-screen
  // order: the cached infinite query that holds the task is that column.
  function neighbour(step: 1 | -1): Task | null {
    if (!task) return null;
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
      if (e.key === "Enter" && isPrimaryModifier(e)) {
        // The comment box handles its own ⌘Enter and stops propagation.
        e.preventDefault();
        if (isNew) void createNow();
        else flush();
        return;
      }
      if (task && (e.key === "c" || e.key === "C") && isPrimaryModifier(e) && !e.altKey) {
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
      const picker = PICKER_KEYS[key];
      // Only open pickers whose chip is on screen: status and bet need a
      // project, and a recurring template has no deadline, reviewer or bet.
      const hidden =
        (!project && (picker === "status" || picker === "bet")) ||
        (recurrence.enabled &&
          (picker === "deadline" || picker === "reviewer" || picker === "bet"));
      if (picker && !hidden) {
        e.preventDefault();
        setOpen(picker);
      } else if (key === "c" && task) {
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
    if (!task || !confirm(`Delete ${task.key}?`)) return;
    await deleteTask.mutateAsync(task.key);
    onClose();
  }

  const pickerProps = (name: Picker) => ({
    open: open === name,
    onOpenChange: (o: boolean) => setOpen(o ? name : null),
  });
  const tone = KIND_TONE[column?.kind ?? "other"] ?? KIND_TONE.other;
  const timeInColumn =
    task?.current_column_since && columnId === task.column?.id
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
              {task?.key ?? "New task"}
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
            {task ? (
              <>
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
                      onClick={() =>
                        void copyTaskPrompt(task, { title, description })
                      }
                    >
                      Copy prompt for Claude
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                      Delete task
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <Button
                size="sm"
                className="h-7 gap-1.5"
                disabled={!canCreate}
                onClick={() => void createNow()}
              >
                {creating ? "Creating…" : recurrence.enabled ? "Create recurring" : "Create"}
                <kbd className="font-mono text-[10px] opacity-70 max-lg:hidden">⌘↵</kbd>
              </Button>
            )}
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
              {task ? (
                <TaskActivity
                  taskKey={task.key}
                  meId={me?.id ?? null}
                  linkedPrs={task.linked_prs}
                  composerRef={composerRef}
                />
              ) : (
                <>
                  <h3 className="px-4 pt-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Activity
                  </h3>
                  <p className="px-4 text-[12px] text-muted-foreground">
                    Comments and history show up here once the task is created.
                  </p>
                </>
              )}
            </aside>

            <main className="group/doc flex-1 min-w-0 min-h-0 flex flex-col px-8 pt-6 pb-4 max-lg:order-1 max-lg:px-4 max-lg:pt-4">
              <input
                value={title}
                onChange={(e) => changeTitle(e.target.value)}
                onBlur={() => {
                  if (!isNew && !title.trim()) setTitle(savedTitle.current);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isPrimaryModifier(e.nativeEvent)) {
                    e.currentTarget.blur();
                  }
                }}
                autoFocus={isNew}
                placeholder="Task title"
                className="shrink-0 w-full bg-transparent text-[22px] font-semibold tracking-tight leading-tight outline-none placeholder:text-muted-foreground/50"
              />

              <div className="shrink-0 flex flex-wrap items-center gap-1.5 mt-3 -ml-2">
                {/* Project first: status and bet depend on it. */}
                <Popover {...pickerProps("project")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="" muted={!project}>
                        {project ? (
                          <>
                            <span
                              className="size-2 rounded-full"
                              style={{ background: project.color }}
                            />
                            {project.name}
                          </>
                        ) : (
                          <>
                            <FolderOpen className="size-3.5" />
                            No project
                          </>
                        )}
                      </Chip>
                    }
                  />
                  <ListContent picker="project" className="w-56">
                    {[...projects, null].map((p) => (
                      <MenuRow
                        key={p?.id ?? "inbox"}
                        selected={projectId === (p?.id ?? null)}
                        onClick={() => changeProject(p?.id ?? null)}
                      >
                        {p ? (
                          <>
                            <span
                              className="size-2 rounded-full"
                              style={{ background: p.color }}
                            />
                            {p.name}
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            No project (Inbox)
                          </span>
                        )}
                      </MenuRow>
                    ))}
                  </ListContent>
                </Popover>

                {project && (
                  <Popover {...pickerProps("status")}>
                    <PopoverTrigger
                      render={
                        <Chip hint="S" className={cn("font-medium", tone.pill)}>
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
                    <ListContent picker="status" className="w-48">
                      {columns.map((c: Column) => (
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
                    </ListContent>
                  </Popover>
                )}

                <Popover {...pickerProps("assignees")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="A" muted={assignees.length === 0}>
                        {assignees.length === 0 ? (
                          "Assignees"
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
                  <ListContent picker="assignees" className="w-52">
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
                  </ListContent>
                </Popover>

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
                  <ListContent picker="priority" className="w-44">
                    {[...PRIORITY_ORDER, null].map((p) => (
                      <MenuRow
                        key={p ?? "none"}
                        selected={priority === p}
                        onClick={() => {
                          setOpen(null);
                          setPriority(p);
                          save({ priority: p });
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
                  </ListContent>
                </Popover>

                {!recurrence.enabled && (
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
                )}

                <Popover {...pickerProps("labels")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="L" muted={labels.length === 0}>
                        {labels.length === 0
                          ? "Labels"
                          : labels.map((l) => (
                              <span
                                key={l.id}
                                className="rounded px-1.5 text-[11.5px] leading-5"
                                style={{ background: `${l.color}22`, color: l.color }}
                              >
                                {l.name}
                              </span>
                            ))}
                      </Chip>
                    }
                  />
                  <ListContent picker="labels" className="w-60">
                    <LabelMenu
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
                  </ListContent>
                </Popover>

                {!recurrence.enabled && (
                  <Popover {...pickerProps("reviewer")}>
                    <PopoverTrigger
                      render={
                        <Chip hint="R" muted={!reviewer}>
                          {reviewer ? (
                            <>
                              <UserAvatar
                                username={reviewer.username}
                                avatarUrl={reviewer.avatar_url}
                                size="size-5"
                              />
                              <span className="text-muted-foreground">Review:</span>
                              {reviewer.username}
                            </>
                          ) : (
                            "Reviewer"
                          )}
                        </Chip>
                      }
                    />
                    <ListContent picker="reviewer" className="w-52">
                      {[...users, null].map((u) => (
                        <MenuRow
                          key={u?.id ?? "none"}
                          selected={reviewerId === (u?.id ?? null)}
                          onClick={() => {
                            setOpen(null);
                            setReviewerId(u?.id ?? null);
                            save({ reviewer_id: u?.id ?? null, optimisticReviewer: u });
                          }}
                        >
                          {u ? (
                            <>
                              <UserAvatar
                                username={u.username}
                                avatarUrl={u.avatar_url}
                                size="size-4"
                              />
                              {u.username}
                              {u.id === me?.id && (
                                <span className="text-muted-foreground">(me)</span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">No reviewer</span>
                          )}
                        </MenuRow>
                      ))}
                    </ListContent>
                  </Popover>
                )}

                <Popover {...pickerProps("points")}>
                  <PopoverTrigger
                    render={
                      <Chip hint="E" muted={!points}>
                        {points ? `${points} pts` : "Points"}
                      </Chip>
                    }
                  />
                  <PopoverContent align="start" className="w-44 p-2 gap-2">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      autoFocus
                      value={points}
                      onChange={(e) => setPoints(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setOpen(null);
                        }
                      }}
                      onBlur={() =>
                        save({ story_points: points === "" ? null : Number(points) })
                      }
                      placeholder="Story points"
                      className="h-8 text-[12px]"
                    />
                  </PopoverContent>
                </Popover>

                {project && !recurrence.enabled && (
                  <Popover {...pickerProps("bet")}>
                    <PopoverTrigger
                      render={
                        <Chip hint="B" muted={!bet}>
                          {bet ? (
                            <>
                              <span
                                className="size-2 rounded-full"
                                style={{ background: bet.color }}
                              />
                              {bet.name}
                            </>
                          ) : (
                            "Bet"
                          )}
                        </Chip>
                      }
                    />
                    <ListContent picker="bet" className="w-56">
                      {[...betOptions, null].map((b) => (
                        <MenuRow
                          key={b?.id ?? "none"}
                          selected={betId === (b?.id ?? null)}
                          onClick={() => {
                            setOpen(null);
                            setBetId(b?.id ?? null);
                            save({ bet_id: b?.id ?? null, optimisticBet: b });
                          }}
                        >
                          {b ? (
                            <>
                              <span
                                className="size-2 rounded-full"
                                style={{ background: b.color }}
                              />
                              {b.name}
                            </>
                          ) : (
                            <span className="text-muted-foreground">No bet</span>
                          )}
                        </MenuRow>
                      ))}
                    </ListContent>
                  </Popover>
                )}

                {/* Repeat makes the new task a recurring template instead. */}
                {isNew && project && (
                  <Popover {...pickerProps("repeat")}>
                    <PopoverTrigger
                      render={
                        <Chip hint="" muted={!recurrence.enabled}>
                          <Repeat className="size-3.5" />
                          {recurrence.enabled ? "Repeats" : "Repeat"}
                        </Chip>
                      }
                    />
                    <PopoverContent align="start" className="w-72 p-3 gap-2">
                      <label className="flex items-center justify-between text-[12px]">
                        Repeat this task
                        <Switch
                          checked={recurrence.enabled}
                          onCheckedChange={(v) =>
                            setRecurrence({ ...recurrence, enabled: v })
                          }
                        />
                      </label>
                      {recurrence.enabled && (
                        <RecurrencePicker state={recurrence} onChange={setRecurrence} />
                      )}
                    </PopoverContent>
                  </Popover>
                )}
              </div>

              {task &&
                (task.linked_prs.length > 0 || task.sources.length > 0) && (
                  <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[12px] text-muted-foreground">
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
                  onSubmit={() => (isNew ? void createNow() : flush())}
                />
              </div>

              <div className="shrink-0 flex flex-wrap gap-x-3 gap-y-1 pt-3 text-[11px] text-muted-foreground/70 max-lg:hidden">
                <KeyHint k="S">status</KeyHint>
                <KeyHint k="A">assign</KeyHint>
                <KeyHint k="P">priority</KeyHint>
                <KeyHint k="D">deadline</KeyHint>
                <KeyHint k="L">labels</KeyHint>
                <KeyHint k="R">reviewer</KeyHint>
                <KeyHint k="E">points</KeyHint>
                <KeyHint k="B">bet</KeyHint>
                {task ? (
                  <>
                    <KeyHint k="C">comment</KeyHint>
                    <KeyHint k="J K">next / prev</KeyHint>
                  </>
                ) : (
                  <KeyHint k="⌘↵">create</KeyHint>
                )}
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
      {hint && (
        <kbd className="pointer-events-none absolute -top-1.5 -right-1 rounded border border-border bg-card px-1 font-mono text-[9px] leading-[14px] text-muted-foreground opacity-0 transition-opacity group-hover/doc:opacity-100 hover-none:hidden">
          {hint}
        </kbd>
      )}
    </button>
  );
}

/** Popover body for a list picker: arrow keys move between rows, and it
 *  opens on the current value. */
function ListContent({
  picker,
  className,
  children,
}: {
  picker: Picker;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <PopoverContent
      align="start"
      className={cn("p-1 gap-0", className)}
      data-picker={picker}
      initialFocus={focusSelected(picker)}
      onKeyDown={listKeys}
    >
      {children}
    </PopoverContent>
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

/** Default first run for a new recurring task: the top of the next hour. */
function nextHourLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d.toISOString());
}
