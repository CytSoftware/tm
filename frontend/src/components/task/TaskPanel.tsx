"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, X } from "lucide-react";

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
import { DescriptionEditor } from "./DescriptionEditor";
import { RecurrencePicker, type RecurrenceState } from "./RecurrencePicker";
import { useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { apiFetch } from "@/lib/api";
import { projectsKey, recurringKey, taskListKey } from "@/lib/query-keys";
import type {
  Project,
  Task,
  Priority,
  Label as LabelType,
  RecurringTaskTemplate,
} from "@/lib/types";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  projects: Project[];
  activeProject: Project;
  mode: "create" | "edit";
  task?: Task;
  initialColumnId?: number;
  onClose: () => void;
};

export function TaskPanel({
  projects,
  activeProject,
  mode,
  task,
  initialColumnId,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const usersQuery = useUsersQuery();
  const users = usersQuery.data ?? [];

  const initialProjectId =
    mode === "edit" ? task!.project : activeProject.id;
  const [projectId, setProjectId] = useState<number>(initialProjectId);
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? activeProject,
    [projects, projectId, activeProject],
  );

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<Priority>(
    task?.priority ?? "MEDIUM",
  );
  const [storyPoints, setStoryPoints] = useState<string>(
    task?.story_points != null ? String(task.story_points) : "",
  );
  const [assigneeId, setAssigneeId] = useState<number | null>(
    task?.assignee?.id ?? null,
  );
  const [labelIds, setLabelIds] = useState<number[]>(
    task?.labels.map((l) => l.id) ?? [],
  );

  const pickDefaultColumn = (p: Project, currentColName?: string) => {
    // When switching projects, try to find a column with the same name first
    if (currentColName) {
      const sameNameCol = p.columns.find((c) => c.name === currentColName);
      if (sameNameCol) return sameNameCol.id;
    }
    return (
      p.columns.find((c) => c.id === initialColumnId)?.id ??
      task?.column.id ??
      p.columns.find((c) => c.name === "Todo")?.id ??
      p.columns.find((c) => !c.is_done)?.id ??
      p.columns[0]?.id ??
      0
    );
  };

  const [columnId, setColumnId] = useState<number>(
    pickDefaultColumn(selectedProject),
  );

  useEffect(() => {
    // When project changes, remap the column to one in the new project
    const currentCol = selectedProject.columns.find((c) => c.id === columnId);
    const currentColName = currentCol?.name ?? task?.column.name;
    setColumnId(pickDefaultColumn(selectedProject, currentColName));
    // Keep global labels (project=null), drop project-scoped ones from the old project
    setLabelIds((prev) =>
      prev.filter((id) => {
        const label = availableLabels.find((l) => l.id === id);
        return label && !label.project; // keep only global labels
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject.id]);

  const [recurrence, setRecurrence] = useState<RecurrenceState>({
    enabled: false,
    preset: "daily",
    weekdays: ["MO"],
    monthDay: 1,
    customRrule: "",
    dtstartLocal: defaultDtstartLocal(),
  });

  // Fetch labels for the selected project
  const labelsQuery = useQuery({
    queryKey: ["labels", selectedProject.id],
    queryFn: () =>
      apiFetch<LabelType[]>(`/api/projects/${selectedProject.id}/labels/`),
    enabled: !!selectedProject.id,
  });
  const availableLabels = labelsQuery.data ?? [];

  const createTask = useCreateTask(selectedProject.id);
  const updateTask = useUpdateTask(selectedProject.id);
  const deleteTask = useDeleteTask(selectedProject.id);

  const createRecurring = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch<RecurringTaskTemplate>("/api/recurring-tasks/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: recurringKey(selectedProject.id),
      });
      queryClient.invalidateQueries({
        queryKey: taskListKey(selectedProject.id),
      });
    },
  });

  const saving =
    createTask.isPending ||
    updateTask.isPending ||
    createRecurring.isPending;

  const projectItems = useMemo(
    () =>
      Object.fromEntries(
        projects.map((p) => [String(p.id), `${p.name} (${p.prefix})`]),
      ) as Record<string, React.ReactNode>,
    [projects],
  );
  const columnItems = useMemo(
    () =>
      Object.fromEntries(
        selectedProject.columns
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((c) => [String(c.id), c.name]),
      ) as Record<string, React.ReactNode>,
    [selectedProject],
  );
  const priorityItems = useMemo(
    () =>
      Object.fromEntries(
        PRIORITY_ORDER.map((p) => [p, PRIORITY_LABELS[p]]),
      ) as Record<string, React.ReactNode>,
    [],
  );
  const assigneeItems = useMemo(
    () => ({
      "": "Unassigned",
      ...Object.fromEntries(
        users.map((u) => [String(u.id), u.username]),
      ),
    }),
    [users],
  );

  async function handleSubmit() {
    if (!title.trim()) return;

    if (mode === "create" && recurrence.enabled) {
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
      });
      onClose();
      return;
    }

    const payload: Record<string, unknown> = {
      project_id: selectedProject.id,
      column_id: columnId,
      title,
      description,
      priority,
      story_points: storyPoints === "" ? null : Number(storyPoints),
      assignee_id: assigneeId,
      label_ids: labelIds,
    };

    if (mode === "create") {
      await createTask.mutateAsync(payload as any);
    } else if (task) {
      await updateTask.mutateAsync({ key: task.key, ...payload } as any);
      // If project changed, also invalidate the old project's task list
      if (task.project !== selectedProject.id) {
        queryClient.invalidateQueries({
          queryKey: taskListKey(task.project),
        });
        queryClient.invalidateQueries({ queryKey: projectsKey() });
      }
    }
    onClose();
  }

  async function handleDelete() {
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
              : `${task?.key} — ${task?.title}`}
          </h2>
          <div className="flex items-center gap-2">
            {mode === "edit" && (
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

        {/* Body — single column: fields on top, description fills rest */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Fields section — compact, non-scrolling */}
          <div className="shrink-0 px-6 pt-4 pb-3 space-y-3 border-b border-border/60">
            {/* Title — full width */}
            <Field label="Title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short description of the work"
                autoFocus
                className="text-[13px]"
              />
            </Field>

            {/* Field grid — compact row */}
            <div className="grid grid-cols-5 gap-2">
              <Field label="Project">
                <Select
                  value={String(projectId)}
                  onValueChange={(v) => setProjectId(Number(v))}
                  items={projectItems}
                >
                  <SelectTrigger className="h-8 text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name} ({p.prefix})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Column">
                <Select
                  value={String(columnId)}
                  onValueChange={(v) => setColumnId(Number(v))}
                  items={columnItems}
                >
                  <SelectTrigger className="h-8 text-[13px]">
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
              </Field>

              <Field label="Priority">
                <Select
                  value={priority}
                  onValueChange={(v) => setPriority(v as Priority)}
                  items={priorityItems}
                >
                  <SelectTrigger className="h-8 text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_ORDER.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Points">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={storyPoints}
                  onChange={(e) => setStoryPoints(e.target.value)}
                  placeholder="—"
                  className="h-8 text-[13px]"
                />
              </Field>

              <Field label="Assignee">
                <Select
                  value={assigneeId != null ? String(assigneeId) : ""}
                  onValueChange={(v) =>
                    setAssigneeId(v === "" ? null : Number(v))
                  }
                  items={assigneeItems}
                >
                  <SelectTrigger className="h-8 text-[13px]">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Unassigned</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {/* Labels */}
            <Field label="Labels">
              <LabelPicker
                available={availableLabels}
                selected={labelIds}
                onChange={setLabelIds}
              />
            </Field>

            {/* Recurrence (create mode only) */}
            {mode === "create" && (
              <div className="rounded-lg border border-border/80 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium">
                    Repeat on a schedule
                  </span>
                  <Switch
                    checked={recurrence.enabled}
                    onCheckedChange={(v) =>
                      setRecurrence({ ...recurrence, enabled: v })
                    }
                  />
                </div>
                {recurrence.enabled && (
                  <RecurrencePicker
                    state={recurrence}
                    onChange={setRecurrence}
                  />
                )}
              </div>
            )}
          </div>

          {/* Description — fills all remaining vertical space */}
          <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden">
            <div className="shrink-0 px-6 pt-3 pb-1">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Description
              </span>
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

function buildRrule(state: RecurrenceState): string | null {
  if (!state.enabled) return null;
  switch (state.preset) {
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly": {
      const days = state.weekdays.join(",");
      return days ? `FREQ=WEEKLY;BYDAY=${days}` : "FREQ=WEEKLY";
    }
    case "monthly":
      return `FREQ=MONTHLY;BYMONTHDAY=${state.monthDay}`;
    case "custom":
      return state.customRrule.trim() || null;
    default:
      return null;
  }
}
