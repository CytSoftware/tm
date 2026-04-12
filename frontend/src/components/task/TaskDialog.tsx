"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { DescriptionEditor } from "./DescriptionEditor";
import { RecurrencePicker, type RecurrenceState } from "./RecurrencePicker";
import { useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/use-tasks";
import { apiFetch } from "@/lib/api";
import { recurringKey, taskListKey } from "@/lib/query-keys";
import type {
  Project,
  Task,
  Priority,
  RecurringTaskTemplate,
} from "@/lib/types";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "@/lib/types";

type Props = {
  projects: Project[];
  activeProject: Project;
  mode: "create" | "edit";
  task?: Task;
  initialColumnId?: number;
  onClose: () => void;
};

export function TaskDialog({
  projects,
  activeProject,
  mode,
  task,
  initialColumnId,
  onClose,
}: Props) {
  const queryClient = useQueryClient();

  // On edit, the task's project is the source of truth and is not reassignable
  // (task keys are project-prefixed, so reparenting would break CYT-001).
  const initialProjectId =
    mode === "edit" ? task!.project ?? activeProject.id : activeProject.id;
  const [projectId, setProjectId] = useState<number>(initialProjectId);
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? activeProject,
    [projects, projectId, activeProject],
  );

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<Priority>(
    (task?.priority ?? "P3") as Priority,
  );
  const [storyPoints, setStoryPoints] = useState<string>(
    task?.story_points != null ? String(task.story_points) : "",
  );

  const pickDefaultColumn = (p: Project) => {
    return (
      p.columns.find((c) => c.id === initialColumnId)?.id ??
      task?.column?.id ??
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
    if (mode === "create") {
      setColumnId(pickDefaultColumn(selectedProject));
    }
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

  // --- items maps so <SelectValue /> renders real labels, not raw IDs ---
  const projectItems = useMemo(
    () =>
      Object.fromEntries(
        projects.map((p) => [String(p.id), projectLabel(p)]),
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

    const payload = {
      project_id: selectedProject.id,
      column_id: columnId,
      title,
      description,
      priority,
      story_points: storyPoints === "" ? null : Number(storyPoints),
    };

    if (mode === "create") {
      await createTask.mutateAsync(payload);
    } else if (task) {
      await updateTask.mutateAsync({ key: task.key, ...payload });
    }
    onClose();
  }

  async function handleDelete() {
    if (!task) return;
    if (!confirm(`Delete ${task.key}?`)) return;
    await deleteTask.mutateAsync(task.key);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-xl max-h-[85vh] p-0 gap-0 flex flex-col overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            {mode === "create"
              ? "New task"
              : `${task?.key} — ${task?.title}`}
          </DialogTitle>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Title
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short description of the work"
              autoFocus
              className="text-[14px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Project
              </Label>
              <Select
                value={String(projectId)}
                onValueChange={(v) => setProjectId(Number(v))}
                items={projectItems}
                disabled={mode === "edit"}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {projectLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Column
              </Label>
              <Select
                value={String(columnId)}
                onValueChange={(v) => setColumnId(Number(v))}
                items={columnItems}
              >
                <SelectTrigger className="h-9 text-[13px]">
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
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Priority
              </Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as Priority)}
                items={priorityItems}
              >
                <SelectTrigger className="h-9 text-[13px]">
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
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Story points
              </Label>
              <Input
                type="number"
                min={0}
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
                placeholder="—"
                className="h-9 text-[13px]"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Description
            </Label>
            <DescriptionEditor
              value={description}
              onChange={setDescription}
            />
          </div>

          {mode === "create" && (
            <div className="rounded-lg border border-border/80 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[13px] font-medium">
                  Repeat on a schedule
                </Label>
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

        {/* Footer — plain div; shadcn's DialogFooter uses -mx-4 -mb-4 which
            fights our p-0 content. */}
        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex items-center justify-end gap-2">
          {mode === "edit" && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
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
      </DialogContent>
    </Dialog>
  );
}

function projectLabel(p: Project): string {
  return `${p.name} (${p.prefix})`;
}

function defaultDtstartLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return formatForDatetimeLocal(d);
}

function formatForDatetimeLocal(d: Date): string {
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
