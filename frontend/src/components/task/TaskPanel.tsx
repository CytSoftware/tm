"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { DescriptionEditor } from "./DescriptionEditor";
import {
  RecurrencePicker,
  buildRrule,
  parseRruleToState,
  type RecurrenceState,
} from "./RecurrencePicker";
import { TimeInColumn, formatDuration } from "./TimeInColumn";
import { useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { apiFetch } from "@/lib/api";
import { projectsKey, taskListKey } from "@/lib/query-keys";
import type {
  Project,
  Task,
  Priority,
  Label as LabelType,
  RecurringTaskTemplate,
  StateTransition,
  User,
} from "@/lib/types";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  projects: Project[];
  /** Pre-selected project for "create" mode. Null means "start in Inbox". */
  activeProject: Project | null;
  onClose: () => void;
} & (
  | { mode: "create"; task?: never; template?: never; initialColumnId?: number }
  | { mode: "edit"; task: Task; template?: never; initialColumnId?: never }
  | {
      mode: "edit-recurring";
      template: RecurringTaskTemplate;
      task?: never;
      initialColumnId?: never;
    }
);

export function TaskPanel(props: Props) {
  const {
    projects,
    activeProject,
    mode,
    onClose,
  } = props;
  const task = props.mode === "edit" ? props.task : undefined;
  const template =
    props.mode === "edit-recurring" ? props.template : undefined;
  const initialColumnId =
    props.mode === "create" ? props.initialColumnId : undefined;
  const queryClient = useQueryClient();
  const usersQuery = useUsersQuery();
  const users = usersQuery.data ?? [];

  // projectId === null means "Inbox" (projectless task). Templates always
  // have a project — they can't live in the Inbox.
  const initialProjectId: number | null = task
    ? task.project
    : template
      ? template.project
      : activeProject?.id ?? null;
  const [projectId, setProjectId] = useState<number | null>(initialProjectId);
  const selectedProject = useMemo(
    () =>
      projectId == null
        ? null
        : projects.find((p) => p.id === projectId) ?? activeProject,
    [projects, projectId, activeProject],
  );

  // Source of shared fields (title, priority, assignees, etc.). Both
  // Task and RecurringTaskTemplate share this shape.
  const seed = task ?? template;
  const [title, setTitle] = useState(seed?.title ?? "");
  const [description, setDescription] = useState(seed?.description ?? "");
  const [priority, setPriority] = useState<Priority | null>(
    seed?.priority ?? null,
  );
  const [storyPoints, setStoryPoints] = useState<string>(
    seed?.story_points != null ? String(seed.story_points) : "",
  );
  const [dueAt, setDueAt] = useState<string>(
    task?.due_at ? task.due_at.slice(0, 16) : "",
  );
  const [assigneeIds, setAssigneeIds] = useState<number[]>(
    seed?.assignees?.map((u) => u.id) ?? [],
  );
  const [labelIds, setLabelIds] = useState<number[]>(
    seed?.labels.map((l) => l.id) ?? [],
  );
  // Only meaningful in `edit-recurring` mode. Controls pause/resume.
  const [active, setActive] = useState<boolean>(template?.active ?? true);

  const pickDefaultColumn = (
    p: Project | null,
    currentColName?: string,
  ): number | null => {
    if (!p) return null;
    // When switching projects, try to find a column with the same name first
    if (currentColName) {
      const sameNameCol = p.columns.find((c) => c.name === currentColName);
      if (sameNameCol) return sameNameCol.id;
    }
    return (
      p.columns.find((c) => c.id === initialColumnId)?.id ??
      task?.column?.id ??
      template?.column?.id ??
      p.columns.find((c) => c.name === "Todo")?.id ??
      p.columns.find((c) => !c.is_done)?.id ??
      p.columns[0]?.id ??
      null
    );
  };

  const [columnId, setColumnId] = useState<number | null>(
    pickDefaultColumn(selectedProject),
  );

  useEffect(() => {
    // When project changes, remap the column to one in the new project (or
    // clear it entirely if we're moving into the Inbox).
    const currentCol =
      selectedProject?.columns.find((c) => c.id === columnId) ?? null;
    const currentColName = currentCol?.name ?? task?.column?.name;
    setColumnId(pickDefaultColumn(selectedProject, currentColName));
    // Keep global labels (project=null), drop project-scoped ones from the old project
    setLabelIds((prev) =>
      prev.filter((id) => {
        const label = availableLabels.find((l) => l.id === id);
        return label && !label.project; // keep only global labels
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id]);

  const [recurrence, setRecurrence] = useState<RecurrenceState>(() =>
    template
      ? parseRruleToState(template.rrule, template.dtstart)
      : {
          enabled: false,
          preset: "daily",
          weekdays: ["MO"],
          monthDay: 1,
          customRrule: "",
          dtstartLocal: defaultDtstartLocal(),
        },
  );

  // Fetch labels for the selected project (or global labels when in the Inbox)
  const labelsQuery = useQuery({
    queryKey: ["labels", selectedProject?.id ?? "global"],
    queryFn: () =>
      selectedProject
        ? apiFetch<LabelType[]>(`/api/projects/${selectedProject.id}/labels/`)
        : apiFetch<{ results: LabelType[] }>("/api/labels/").then((r) =>
            r.results.filter((l) => l.project == null),
          ),
  });
  const availableLabels = labelsQuery.data ?? [];

  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const createRecurring = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch<RecurringTaskTemplate>("/api/recurring-tasks/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      // Invalidate the whole "recurring" prefix so RecurringManager's
      // "all" scope refetches too, not only the per-project listing.
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
      if (selectedProject) {
        queryClient.invalidateQueries({
          queryKey: taskListKey(selectedProject.id),
        });
      }
    },
  });

  const updateRecurring = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch<RecurringTaskTemplate>(
        `/api/recurring-tasks/${template?.id}/`,
        { method: "PATCH", body: payload },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
      if (template?.project != null) {
        queryClient.invalidateQueries({
          queryKey: taskListKey(template.project),
        });
      }
    },
  });

  const deleteRecurring = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/recurring-tasks/${template?.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
    },
  });

  const saving =
    createTask.isPending ||
    updateTask.isPending ||
    createRecurring.isPending ||
    updateRecurring.isPending;

  const projectItems = useMemo(
    () =>
      ({
        "": "No project (Inbox)",
        ...Object.fromEntries(
          projects.map((p) => [String(p.id), `${p.name} (${p.prefix})`]),
        ),
      }) as Record<string, React.ReactNode>,
    [projects],
  );
  const columnItems = useMemo(
    () =>
      Object.fromEntries(
        (selectedProject?.columns ?? [])
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((c) => [String(c.id), c.name]),
      ) as Record<string, React.ReactNode>,
    [selectedProject],
  );
  const priorityItems = useMemo(
    () =>
      ({
        "": "No priority",
        ...Object.fromEntries(
          PRIORITY_ORDER.map((p) => [p, PRIORITY_LABELS[p]]),
        ),
      }) as Record<string, React.ReactNode>,
    [],
  );

  async function handleSubmit() {
    if (!title.trim()) return;

    if (mode === "edit-recurring" && template) {
      const rrule = buildRrule(recurrence);
      if (!rrule || !recurrence.dtstartLocal) return;
      const payload: Record<string, unknown> = {
        title,
        description,
        priority,
        story_points: storyPoints === "" ? null : Number(storyPoints),
        column_id: columnId,
        assignee_ids: assigneeIds,
        label_ids: labelIds,
        rrule,
        dtstart: new Date(recurrence.dtstartLocal).toISOString(),
        active,
      };
      if (projectId != null && projectId !== template.project) {
        payload.project_id = projectId;
      }
      await updateRecurring.mutateAsync(payload);
      onClose();
      return;
    }

    if (mode === "create" && recurrence.enabled) {
      if (!selectedProject) {
        alert("Recurring tasks need a project.");
        return;
      }
      const rrule = buildRrule(recurrence);
      if (!rrule) return;
      await createRecurring.mutateAsync({
        project_id: selectedProject.id,
        column_id: columnId,
        title,
        description,
        priority,
        story_points: storyPoints === "" ? null : Number(storyPoints),
        rrule,
        dtstart: new Date(recurrence.dtstartLocal).toISOString(),
        timezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        active: true,
        assignee_ids: assigneeIds,
      });
      onClose();
      return;
    }

    const payload: Record<string, unknown> = {
      project_id: selectedProject?.id ?? null,
      column_id: selectedProject ? columnId : null,
      title,
      description,
      priority,
      story_points: storyPoints === "" ? null : Number(storyPoints),
      due_at: dueAt ? new Date(dueAt).toISOString() : null,
      assignee_ids: assigneeIds,
      label_ids: labelIds,
    };

    if (mode === "create") {
      await createTask.mutateAsync(payload as any);
    } else if (task) {
      await updateTask.mutateAsync({ key: task.key, ...payload } as any);
      // If project changed, also invalidate the old project's task list
      if (task.project !== selectedProject?.id) {
        if (task.project != null) {
          queryClient.invalidateQueries({
            queryKey: taskListKey(task.project),
          });
        }
        queryClient.invalidateQueries({ queryKey: projectsKey() });
      }
    }
    onClose();
  }

  async function handleDelete() {
    if (mode === "edit-recurring" && template) {
      if (
        !confirm(
          `Delete recurring template "${template.title}"?\n\nFuture instances will stop being generated. Tasks already created by this template are kept.`,
        )
      ) {
        return;
      }
      await deleteRecurring.mutateAsync();
      onClose();
      return;
    }
    if (!task) return;
    if (!confirm(`Delete ${task.key}?`)) return;
    await deleteTask.mutateAsync(task.key);
    onClose();
  }

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Panel — bottom-anchored */}
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center pointer-events-none">
      <div className="pointer-events-auto w-full max-w-5xl h-[88vh] flex flex-col rounded-t-xl border border-b-0 border-border bg-card shadow-2xl animate-in slide-in-from-bottom duration-300">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-border/60">
          <h2 className="text-[15px] font-semibold tracking-tight">
            {mode === "create"
              ? "New task"
              : mode === "edit-recurring"
                ? `Recurring — ${template?.title ?? ""}`
                : `${task?.key} — ${task?.title}`}
          </h2>
          <div className="flex items-center gap-2">
            {mode !== "create" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={handleDelete}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            )}
            <Button variant="ghost" size="icon" className="size-8" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Body — two columns: left properties sidebar, right title+description */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: property sidebar */}
          <div className="w-64 shrink-0 border-r border-border/60 overflow-y-auto scrollbar-none p-4 space-y-1">
            <PropRow label="Project">
              <Select
                value={projectId != null ? String(projectId) : ""}
                onValueChange={(v) =>
                  setProjectId(v === "" ? null : Number(v))
                }
                items={projectItems}
              >
                <SelectTrigger className="h-7 w-full text-[12px] border-0 bg-transparent px-1 hover:bg-accent/60 rounded">
                  <SelectValue placeholder="No project (Inbox)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No project (Inbox)</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: p.color }}
                        />
                        {p.name} ({p.prefix})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PropRow>

            {selectedProject && columnId != null && (
              <PropRow label="Status">
                <Select
                  value={String(columnId)}
                  onValueChange={(v) => setColumnId(Number(v))}
                  items={columnItems}
                >
                  <SelectTrigger className="h-7 w-full text-[12px] border-0 bg-transparent px-1 hover:bg-accent/60 rounded">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedProject.columns
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </PropRow>
            )}

            {mode === "edit" && task?.current_column_since && (
              <div className="flex items-start min-h-[22px]">
                <span className="w-[72px] shrink-0 text-[12px] text-muted-foreground pl-1" />
                <div className="flex-1 min-w-0 pl-1.5">
                  <TimeInColumn task={task} size="sm" durationOnly />
                </div>
              </div>
            )}

            <PropRow label="Priority">
              <Select
                value={priority ?? ""}
                onValueChange={(v) =>
                  setPriority(v === "" ? null : (v as Priority))
                }
                items={priorityItems}
              >
                <SelectTrigger className="h-7 w-full text-[12px] border-0 bg-transparent px-1 hover:bg-accent/60 rounded">
                  <SelectValue placeholder="No priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No priority</SelectItem>
                  {PRIORITY_ORDER.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PropRow>

            <div className="flex items-start min-h-[32px]">
              <span className="w-[72px] shrink-0 text-[12px] text-muted-foreground pl-1 pt-1.5">
                Assignees
              </span>
              <div className="flex-1 min-w-0">
                <AssigneePicker
                  available={users}
                  selected={assigneeIds}
                  onChange={setAssigneeIds}
                />
              </div>
            </div>

            <PropRow label="Points">
              <Input
                type="number"
                min={1}
                step={1}
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
                placeholder="—"
                className="h-7 text-[12px] border-0 bg-transparent px-1.5 hover:bg-accent/60 rounded w-full"
              />
            </PropRow>

            {mode !== "edit-recurring" && (
              <PropRow label="Deadline">
                <Input
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="h-7 text-[12px] border-0 bg-transparent px-1.5 hover:bg-accent/60 rounded w-full"
                />
              </PropRow>
            )}

            <div className="pt-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">
                Labels
              </span>
              <div className="mt-1">
                <LabelPicker
                  available={availableLabels}
                  selected={labelIds}
                  onChange={setLabelIds}
                />
              </div>
            </div>

            {mode === "create" && (
              <div className="pt-2 mt-2 border-t border-border/40">
                <div className="flex items-center justify-between px-1 py-1">
                  <span className="text-[11px] text-muted-foreground">
                    Recurring
                  </span>
                  <Switch
                    checked={recurrence.enabled}
                    onCheckedChange={(v) =>
                      setRecurrence({ ...recurrence, enabled: v })
                    }
                  />
                </div>
                {recurrence.enabled && (
                  <div className="mt-1">
                    <RecurrencePicker
                      state={recurrence}
                      onChange={setRecurrence}
                    />
                  </div>
                )}
              </div>
            )}

            {mode === "edit-recurring" && (
              <div className="pt-2 mt-2 border-t border-border/40">
                <div className="flex items-center justify-between px-1 py-1">
                  <span className="text-[11px] text-muted-foreground">
                    Active
                  </span>
                  <Switch checked={active} onCheckedChange={setActive} />
                </div>
                <div className="mt-1">
                  <RecurrencePicker
                    state={recurrence}
                    onChange={setRecurrence}
                  />
                </div>
              </div>
            )}

            {mode === "edit" && task && (
              <div className="pt-2 mt-2 border-t border-border/40">
                <TransitionHistory taskKey={task.key} />
              </div>
            )}
          </div>

          {/* Right: title + description */}
          <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden">
            <div className="shrink-0 px-6 pt-4 pb-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                autoFocus
                className="text-[16px] font-medium border-0 bg-transparent px-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="flex-1 min-h-0 px-6 pb-4">
              <DescriptionEditor
                value={description}
                onChange={setDescription}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-3 border-t border-border/60 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </div>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function PropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center min-h-[32px]">
      <span className="w-[72px] shrink-0 text-[12px] text-muted-foreground pl-1">
        {label}
      </span>
      <div className="w-[160px] shrink-0">{children}</div>
    </div>
  );
}

function AssigneePicker({
  available,
  selected,
  onChange,
}: {
  available: User[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  if (available.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground pl-1">
        No users available.
      </p>
    );
  }

  function toggle(id: number) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  }

  const selectedUsers = available.filter((u) => selected.includes(u.id));

  return (
    <div className="space-y-1.5">
      {selectedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedUsers.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u.id)}
              className="inline-flex items-center gap-1 rounded-full bg-accent/60 hover:bg-accent pl-0.5 pr-1.5 py-0.5 text-[11px] transition-colors"
              title={`Unassign ${u.username}`}
            >
              <UserAvatar
                username={u.username}
                avatarUrl={u.avatar_url}
                size="size-4"
              />
              {u.username}
              <X className="size-2.5 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px] text-muted-foreground w-full justify-start"
            >
              + Add assignee
            </Button>
          }
        />
        <PopoverContent className="w-52 p-1" align="start">
          {available.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u.id)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-accent transition-colors"
            >
              <Checkbox checked={selected.includes(u.id)} />
              <UserAvatar
                username={u.username}
                avatarUrl={u.avatar_url}
                size="size-4"
              />
              {u.username}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function LabelPicker({
  available,
  selected,
  onChange,
}: {
  available: LabelType[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  if (available.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No labels in this project. Create them in Django admin.
      </p>
    );
  }

  function toggle(id: number) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  }

  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {available
            .filter((l) => selected.includes(l.id))
            .map((l) => (
              <Badge
                key={l.id}
                variant="outline"
                className="text-[10px] h-5 cursor-pointer"
                style={{
                  background: `${l.color}22`,
                  color: l.color,
                  borderColor: `${l.color}44`,
                }}
                onClick={() => toggle(l.id)}
              >
                {l.name} ×
              </Badge>
            ))}
        </div>
      )}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px] text-muted-foreground w-full justify-start"
            >
              + Add label
            </Button>
          }
        />
        <PopoverContent className="w-52 p-1" align="start">
          {available.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => toggle(l.id)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-accent transition-colors"
            >
              <Checkbox checked={selected.includes(l.id)} />
              <span
                className="size-2 rounded-full"
                style={{ background: l.color }}
              />
              {l.name}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TransitionHistory({ taskKey }: { taskKey: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["task-transitions", taskKey],
    queryFn: () =>
      apiFetch<StateTransition[]>(`/api/tasks/${taskKey}/transitions/`),
    enabled: open,
    staleTime: 10_000,
  });

  const entries = query.data ?? [];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 w-full px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="uppercase tracking-wide">History</span>
        {entries.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
            {entries.length}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 pl-5 pr-1 space-y-1">
          {query.isLoading && (
            <p className="text-[11px] text-muted-foreground">Loading...</p>
          )}
          {!query.isLoading && entries.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              No column changes yet.
            </p>
          )}
          {entries.map((t) => (
            <TransitionRow key={t.id} transition={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TransitionRow({ transition }: { transition: StateTransition }) {
  const from = transition.from_column?.name;
  const to = transition.to_column?.name ?? "—";
  const actor =
    transition.triggered_by?.username ??
    (transition.source === "recurring"
      ? "recurring"
      : transition.source === "backfill"
        ? "backfill"
        : transition.source === "mcp"
          ? "agent"
          : "system");
  const when = formatDuration(transition.at);
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-tight">
      <span className="size-1 rounded-full bg-muted-foreground/40 mt-1.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">
          {from ? (
            <>
              {from} <span className="text-muted-foreground">→</span> {to}
            </>
          ) : (
            <>
              <span className="text-muted-foreground">Placed in</span> {to}
            </>
          )}
        </span>
        <div className="text-muted-foreground/80">
          {actor} · {when} ago
        </div>
      </div>
    </div>
  );
}

function defaultDtstartLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

