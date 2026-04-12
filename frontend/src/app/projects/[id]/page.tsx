"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/ui/ColorPicker";
import { ApiError } from "@/lib/api";
import { useActiveProject } from "@/lib/active-project";
import {
  useProjectQuery,
  useUpdateProject,
  useDeleteProject,
} from "@/hooks/use-projects";
import type { Project } from "@/lib/types";

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = Number(params.id);

  const projectQuery = useProjectQuery(projectId);

  if (projectQuery.isLoading) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
        <p className="text-[14px] text-muted-foreground">Project not found.</p>
        <Button variant="outline" size="sm" onClick={() => router.push("/board")}>
          Back to board
        </Button>
      </div>
    );
  }

  // Key on the server-side `updated_at` so the form re-mounts (and therefore
  // re-initializes its local state) whenever the server returns a newer
  // version of the project — after our own save, or after an external update.
  return (
    <ProjectSettingsForm
      key={`${projectQuery.data.id}:${projectQuery.data.updated_at}`}
      project={projectQuery.data}
    />
  );
}

function ProjectSettingsForm({ project }: { project: Project }) {
  const router = useRouter();
  const { projectId: activeId, setProjectId } = useActiveProject();
  const updateProject = useUpdateProject(project.id);
  const deleteProject = useDeleteProject();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [color, setColor] = useState(project.color);
  const [icon, setIcon] = useState(project.icon);
  const [archived, setArchived] = useState(project.archived);

  const isDirty =
    name !== project.name ||
    description !== project.description ||
    color !== project.color ||
    icon !== project.icon ||
    archived !== project.archived;

  function handleSave() {
    if (!isDirty) return;
    updateProject.mutate({ name, description, color, icon, archived });
  }

  function handleDelete() {
    if (
      !confirm(
        `Delete project "${project.name}" (${project.prefix})?\n\nAll tasks, columns, labels, and recurring templates will be permanently deleted.`,
      )
    ) {
      return;
    }
    deleteProject.mutate(project.id, {
      onSuccess: () => {
        if (activeId === project.id) setProjectId(null);
        router.push("/board");
      },
    });
  }

  function handleBack() {
    setProjectId(project.id);
    router.push("/board");
  }

  const error = updateProject.error;
  const errorMessage =
    error instanceof ApiError
      ? formatApiError(error)
      : error
        ? "Something went wrong."
        : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Page header */}
      <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-border/80 bg-background">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 -ml-2 text-[13px]"
          onClick={handleBack}
        >
          <ArrowLeft className="size-3.5" />
          Back to board
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="size-2.5 rounded-full shrink-0"
            style={{ background: project.color }}
            aria-hidden
          />
          {project.icon && (
            <span className="text-[13px]">{project.icon}</span>
          )}
          <span className="text-[13px] font-medium truncate">
            {project.name}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {project.prefix}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isDirty && (
            <span className="text-[11px] text-muted-foreground">
              Unsaved changes
            </span>
          )}
          <Button
            size="sm"
            className="h-8 text-[13px]"
            disabled={!isDirty || updateProject.isPending}
            onClick={handleSave}
          >
            <Save className="size-3.5" />
            {updateProject.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </header>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-8 space-y-6">
          {/* Name + icon */}
          <div className="space-y-4">
            <div className="grid grid-cols-[auto_1fr] gap-3 items-end">
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Icon
                </Label>
                <Input
                  value={icon}
                  onChange={(e) => setIcon(e.target.value.slice(0, 4))}
                  placeholder="🔧"
                  className="h-9 w-14 text-[16px] text-center"
                  maxLength={4}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Name
                </Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Internal Infra"
                  className="h-9 text-[13px]"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Color
              </Label>
              <ColorPicker value={color} onChange={setColor} />
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">Custom:</span>
                <Input
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-7 w-28 font-mono text-[11px]"
                  placeholder="#6366f1"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Description
              </Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project about?"
                rows={4}
                className="text-[13px] resize-none"
              />
            </div>
          </div>

          {/* Archive toggle */}
          <div className="flex items-center justify-between rounded-md border border-border/60 p-4">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium">Archived</div>
              <div className="text-[11px] text-muted-foreground">
                Archived projects are hidden from the sidebar by default.
              </div>
            </div>
            <Switch checked={archived} onCheckedChange={setArchived} />
          </div>

          {/* Metadata (read-only) */}
          <div className="space-y-2 rounded-md border border-border/60 p-4 text-[12px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Prefix</span>
              <span className="font-mono">{project.prefix}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tasks created</span>
              <span>{project.task_counter}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(project.created_at).toLocaleDateString()}</span>
            </div>
          </div>

          {errorMessage && (
            <p className="text-[12px] text-destructive">{errorMessage}</p>
          )}

          {/* Danger zone */}
          <div className="space-y-3 rounded-md border border-destructive/30 p-4">
            <div>
              <div className="text-[13px] font-medium text-destructive">
                Danger zone
              </div>
              <div className="text-[11px] text-muted-foreground">
                Deleting a project permanently removes all its tasks, columns,
                labels, and recurring templates.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[13px] border-destructive/40 text-destructive hover:bg-destructive/5"
              onClick={handleDelete}
              disabled={deleteProject.isPending}
            >
              <Trash2 className="size-3.5" />
              Delete project
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatApiError(err: ApiError): string {
  const payload = err.payload as
    | Record<string, string[] | string>
    | { detail?: string }
    | null;
  if (!payload) return err.message;
  if (typeof payload === "object" && "detail" in payload && payload.detail) {
    return String(payload.detail);
  }
  if (typeof payload === "object") {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(payload)) {
      const str = Array.isArray(value) ? value.join(" ") : String(value);
      parts.push(`${field}: ${str}`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  return err.message;
}
