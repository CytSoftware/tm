"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Globe, Folder } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/ColorPicker";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { useProjectsQuery } from "@/hooks/use-projects";
import type { Label, Project } from "@/lib/types";

type Props = {
  projectId: number | null;
  projectName: string | null;
  onClose: () => void;
};

export function LabelManager({ projectId, projectName, onClose }: Props) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [scopeProjectId, setScopeProjectId] = useState<number | null>(projectId);

  const projectsQuery = useProjectsQuery();
  const projects: Project[] = projectsQuery.data?.results ?? [];

  const labelsQuery = useQuery({
    queryKey: ["labels", projectId ?? "all"],
    queryFn: () => {
      if (projectId) {
        // Project labels endpoint returns project-specific + global labels
        return apiFetch<Label[]>(`/api/projects/${projectId}/labels/`);
      }
      // No project selected — show all labels
      return apiFetch<{ count: number; results: Label[] }>("/api/labels/").then(
        (r) => r.results,
      );
    },
  });
  const labels = labelsQuery.data ?? [];
  const globalLabels = labels.filter((l) => !l.project);
  const projectLabels = labels.filter((l) => l.project);

  const createLabel = useMutation({
    mutationFn: (payload: {
      project: number | null;
      name: string;
      color: string;
    }) => apiFetch<Label>("/api/labels/", { method: "POST", body: payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
      setNewName("");
    },
  });

  const deleteLabel = useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/labels/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
    },
  });

  function handleCreate() {
    if (!newName.trim()) return;
    createLabel.mutate({
      project: scopeProjectId,
      name: newName.trim(),
      color: newColor,
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-md p-0 gap-0 flex flex-col overflow-hidden max-h-[70vh]"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            Manage labels
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {projectName
              ? `Labels for ${projectName} + global labels`
              : "All labels across projects"}
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Create new label */}
          <div className="space-y-2">
            <div className="space-y-2">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    New label
                  </span>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Label name"
                    className="h-8 text-[13px]"
                    onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  />
                </div>
                <Button
                  size="sm"
                  className="h-8"
                  onClick={handleCreate}
                  disabled={!newName.trim() || createLabel.isPending}
                >
                  <Plus className="size-3.5" />
                  Add
                </Button>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Color
                </span>
                <ColorPicker value={newColor} onChange={setNewColor} />
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Projects
              </span>
              <div className="flex flex-wrap gap-1">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setScopeProjectId(
                        scopeProjectId === p.id ? null : p.id,
                      )
                    }
                    className={cn(
                      "rounded border px-2 py-1 text-[12px] transition-colors",
                      scopeProjectId === p.id
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-foreground/30",
                    )}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {scopeProjectId
                  ? `Scoped to ${projects.find((p) => p.id === scopeProjectId)?.name}`
                  : "No project selected — label will be global"}
              </p>
            </div>
          </div>

          {/* Global labels */}
          {globalLabels.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                <Globe className="size-3" />
                Global labels
              </div>
              {globalLabels.map((l) => (
                <LabelRow key={l.id} label={l} onDelete={deleteLabel.mutate} />
              ))}
            </div>
          )}

          {/* Project labels */}
          {projectLabels.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                <Folder className="size-3" />
                {projectName ? `${projectName} labels` : "Project labels"}
              </div>
              {projectLabels.map((l) => (
                <LabelRow key={l.id} label={l} onDelete={deleteLabel.mutate} />
              ))}
            </div>
          )}

          {labels.length === 0 && (
            <p className="text-[12px] text-muted-foreground text-center py-4">
              No labels yet. Create one above.
            </p>
          )}
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LabelRow({
  label,
  onDelete,
}: {
  label: Label;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40 transition-colors group">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="size-3 rounded-full shrink-0"
          style={{ background: label.color }}
        />
        <span className="text-[13px] truncate">{label.name}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {label.color}
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          if (confirm(`Delete label "${label.name}"?`)) onDelete(label.id);
        }}
        className="size-6 grid place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 transition-opacity"
        aria-label={`Delete ${label.name}`}
      >
        <Trash2 className="size-3 text-destructive" />
      </button>
    </div>
  );
}
