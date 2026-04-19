"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Pencil, Play, Repeat, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TaskPanel } from "@/components/task/TaskPanel";
import { apiFetch } from "@/lib/api";
import { taskListKey } from "@/lib/query-keys";
import { humanizeRrule } from "@/lib/rrule";
import { cn } from "@/lib/utils";
import type { Project, RecurringTaskTemplate } from "@/lib/types";

type Props = {
  /** When non-null, only templates for this project are shown. Null means
   *  "all projects". */
  projectId: number | null;
  projects: Project[];
  onClose: () => void;
};

type ListResponse = {
  count: number;
  results: RecurringTaskTemplate[];
};

export function RecurringManager({ projectId, projects, onClose }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RecurringTaskTemplate | null>(null);

  // Share the "recurring" prefix with `recurringKey` so any mutation in
  // TaskPanel / this modal that invalidates `["recurring"]` refreshes the
  // list. `refetchOnMount: "always"` covers the gap while the modal isn't
  // mounted — cheap because the modal only opens on demand.
  const listKey = ["recurring", projectId ?? "all"] as const;
  const templatesQuery = useQuery({
    queryKey: listKey,
    queryFn: () =>
      apiFetch<ListResponse>("/api/recurring-tasks/", {
        query: projectId ? { project: projectId } : undefined,
      }),
    refetchOnMount: "always",
  });
  const templates = templatesQuery.data?.results ?? [];

  function invalidate(pid: number | null | undefined) {
    // Prefix-match invalidates every recurring-scoped query, including
    // both this modal's view (scoped or "all") and the existing
    // `recurringKey(pid)` queries TaskPanel uses.
    qc.invalidateQueries({ queryKey: ["recurring"] });
    if (pid != null) {
      qc.invalidateQueries({ queryKey: taskListKey(pid) });
    }
  }

  const toggleActive = useMutation({
    mutationFn: async (template: RecurringTaskTemplate) => {
      const action = template.active ? "pause" : "resume";
      return apiFetch<RecurringTaskTemplate>(
        `/api/recurring-tasks/${template.id}/${action}/`,
        { method: "POST" },
      );
    },
    onSuccess: (_data, template) => invalidate(template.project),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (template: RecurringTaskTemplate) => {
      await apiFetch<void>(`/api/recurring-tasks/${template.id}/`, {
        method: "DELETE",
      });
      return template;
    },
    onSuccess: (template) => invalidate(template.project),
  });

  function handleDelete(template: RecurringTaskTemplate) {
    const confirmed = window.confirm(
      `Delete recurring template "${template.title}"?\n\nThis stops future instances from being generated. Tasks already created by this template are kept.`,
    );
    if (!confirmed) return;
    deleteTemplate.mutate(template);
  }

  const scopedProject = projectId
    ? projects.find((p) => p.id === projectId)
    : null;

  // When the user clicks Edit, swap the dialog for a full TaskPanel so the
  // editing UX matches regular task edit. The manager dialog stays closed
  // until TaskPanel closes itself.
  if (editing) {
    return (
      <TaskPanel
        projects={projects}
        activeProject={scopedProject ?? null}
        mode="edit-recurring"
        template={editing}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 flex flex-col overflow-hidden max-h-[80vh]"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight flex items-center gap-2">
            <Repeat className="size-4" />
            Recurring tasks
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {scopedProject
              ? `Templates for ${scopedProject.name}`
              : "Templates across all projects"}
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-2">
          {templatesQuery.isLoading ? (
            <div className="text-[12px] text-muted-foreground py-8 text-center">
              Loading…
            </div>
          ) : templates.length === 0 ? (
            <div className="text-[12px] text-muted-foreground py-8 text-center">
              No recurring templates yet. Create one from the task panel by
              toggling &ldquo;Recurring&rdquo; when creating a task.
            </div>
          ) : (
            templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                showProject={projectId == null}
                projects={projects}
                onToggle={() => toggleActive.mutate(t)}
                onEdit={() => setEditing(t)}
                onDelete={() => handleDelete(t)}
                toggling={
                  toggleActive.isPending &&
                  toggleActive.variables?.id === t.id
                }
                deleting={
                  deleteTemplate.isPending &&
                  deleteTemplate.variables?.id === t.id
                }
              />
            ))
          )}
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateRow({
  template,
  showProject,
  projects,
  onToggle,
  onEdit,
  onDelete,
  toggling,
  deleting,
}: {
  template: RecurringTaskTemplate;
  showProject: boolean;
  projects: Project[];
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  toggling: boolean;
  deleting: boolean;
}) {
  const project = projects.find((p) => p.id === template.project);
  const humanSchedule = humanizeRrule(template.rrule);
  const nextRun = new Date(template.next_run_at);
  const nextRunLabel = Number.isNaN(nextRun.getTime())
    ? "—"
    : nextRun.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-card px-3 py-2.5",
        "flex items-start gap-3",
        !template.active && "opacity-60",
      )}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium truncate">
            {template.title}
          </span>
          {showProject && project && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0"
              style={{
                color: project.color,
                borderColor: `${project.color}55`,
                background: `${project.color}14`,
              }}
            >
              {project.prefix}
            </span>
          )}
          {template.priority && (
            <span className="text-[10px] font-mono text-muted-foreground shrink-0">
              {template.priority}
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
          <span>{humanSchedule}</span>
          <span>
            {template.active ? "Next run" : "Paused — next run"}: {nextRunLabel}
          </span>
          {template.column?.name && <span>→ {template.column.name}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex items-center gap-1.5 mr-1">
          <Switch
            checked={template.active}
            onCheckedChange={onToggle}
            disabled={toggling}
            aria-label={template.active ? "Pause" : "Resume"}
          />
          {template.active ? (
            <Pause className="size-3 text-muted-foreground" />
          ) : (
            <Play className="size-3 text-muted-foreground" />
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onEdit}
          aria-label="Edit"
          title="Edit"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete"
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
