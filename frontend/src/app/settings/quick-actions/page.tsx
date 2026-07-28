"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Save,
  Trash2,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useQuickActions } from "@/hooks/use-quick-actions";
import { useUsersQuery } from "@/hooks/use-users";
import {
  QUICK_ACTION_ICON_OPTIONS,
  QuickActionIcon,
} from "@/lib/quick-actions";
import { cn } from "@/lib/utils";
import type {
  Project,
  QuickAction,
  QuickActionIcon as QuickActionIconName,
  User,
} from "@/lib/types";

type EditorState = {
  id: string | null;
  label: string;
  kind: QuickAction["kind"];
  icon: QuickActionIconName;
  url: string;
  projectId: string;
  userId: string;
};

const EMPTY_EDITOR: EditorState = {
  id: null,
  label: "",
  kind: "page",
  icon: "bolt",
  url: "",
  projectId: "",
  userId: "",
};

export default function QuickActionsSettingsPage() {
  const { query, quickActions, save } = useQuickActions();
  const projectsQuery = useProjectsQuery();
  const usersQuery = useUsersQuery();
  const projects = (projectsQuery.data?.results ?? []).filter(
    (project) => !project.archived,
  );
  const users = usersQuery.data ?? [];
  const [draft, setDraft] = useState<QuickAction[]>([]);
  const [sourceSignature, setSourceSignature] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const signature = JSON.stringify(quickActions);

  if (query.data && sourceSignature === null) {
    setSourceSignature(signature);
    setDraft(quickActions);
  }

  const dirty = JSON.stringify(draft) !== signature;

  function openEditor(action?: QuickAction) {
    if (!action) {
      setEditor({ ...EMPTY_EDITOR });
      return;
    }
    setEditor({
      id: action.id,
      label: action.label,
      kind: action.kind,
      icon: action.icon,
      url: action.kind === "page" ? action.url : "",
      projectId:
        action.kind === "project" ? String(action.project_id) : "",
      userId: action.kind === "assignee" ? String(action.user_id) : "",
    });
  }

  function applyEditor(next: EditorState) {
    const id = next.id ?? crypto.randomUUID();
    const base = { id, label: next.label.trim(), icon: next.icon };
    let action: QuickAction;
    if (next.kind === "project") {
      action = { ...base, kind: "project", project_id: Number(next.projectId) };
    } else if (next.kind === "assignee") {
      action = { ...base, kind: "assignee", user_id: Number(next.userId) };
    } else {
      action = { ...base, kind: "page", url: next.url.trim() };
    }
    setDraft((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return [...current, action];
      return current.map((item) => (item.id === id ? action : item));
    });
    setEditor(null);
  }

  function move(index: number, offset: -1 | 1) {
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function persist() {
    save.mutate(draft, {
      onSuccess: (me) => {
        const saved = me.preferences.quick_actions;
        setDraft(saved);
        setSourceSignature(JSON.stringify(saved));
      },
    });
  }

  if (query.isLoading) {
    return (
      <div className="h-full grid place-items-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="h-full grid place-items-center text-[13px] text-destructive">
        Couldn&apos;t load quick actions.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 min-h-14 px-4 max-lg:px-3 py-2 border-b border-border/80 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-semibold tracking-tight">
            Quick actions
          </h1>
          <p className="text-[11px] text-muted-foreground">
            Build a personal shortcut list for the top of your sidebar.
          </p>
        </div>
        <Button size="sm" onClick={() => openEditor()}>
          <Plus /> Add action
        </Button>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 lg:px-6 py-6 space-y-4">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            {draft.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <Zap className="size-7 mx-auto text-muted-foreground" />
                <p className="mt-3 text-[14px] font-medium">
                  No quick actions
                </p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  The sidebar section stays hidden until you add one.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4"
                  onClick={() => openEditor()}
                >
                  <Plus /> Add your first action
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border/70">
                {draft.map((action, index) => (
                  <div
                    key={action.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <div className="size-8 rounded-md bg-muted grid place-items-center shrink-0">
                      <QuickActionIcon
                        name={action.icon}
                        className="size-3.5"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium truncate">
                        {action.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {describeAction(action, projects, users)}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${action.label} up`}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => move(index, 1)}
                        disabled={index === draft.length - 1}
                        aria-label={`Move ${action.label} down`}
                      >
                        <ChevronDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEditor(action)}
                        aria-label={`Edit ${action.label}`}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setDraft((current) =>
                            current.filter((item) => item.id !== action.id),
                          )
                        }
                        aria-label={`Delete ${action.label}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            {save.isError && (
              <span className="mr-auto text-[11px] text-destructive">
                Couldn&apos;t save quick actions.
              </span>
            )}
            {save.isSuccess && !dirty && (
              <span className="text-[11px] text-muted-foreground">Saved.</span>
            )}
            <Button onClick={persist} disabled={!dirty || save.isPending}>
              <Save /> {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </main>

      {editor && (
        <QuickActionDialog
          editor={editor}
          projects={projects}
          users={users}
          onClose={() => setEditor(null)}
          onSubmit={applyEditor}
        />
      )}
    </div>
  );
}

function describeAction(
  action: QuickAction,
  projects: Project[],
  users: User[],
) {
  if (action.kind === "page") return `Page · ${action.url}`;
  if (action.kind === "project") {
    const project = projects.find((item) => item.id === action.project_id);
    return `Project board · ${project?.name ?? "Unknown project"}`;
  }
  const user = users.find((item) => item.id === action.user_id);
  return `Assigned tasks · ${displayName(user)}`;
}

function displayName(user?: User) {
  if (!user) return "Unknown user";
  const fullName = `${user.first_name} ${user.last_name}`.trim();
  return fullName || user.username;
}

function QuickActionDialog({
  editor,
  projects,
  users,
  onClose,
  onSubmit,
}: {
  editor: EditorState;
  projects: Project[];
  users: User[];
  onClose: () => void;
  onSubmit: (editor: EditorState) => void;
}) {
  const [draft, setDraft] = useState(editor);
  const valid =
    draft.label.trim().length > 0 &&
    ((draft.kind === "page" && draft.url.trim().length > 0) ||
      (draft.kind === "project" && draft.projectId !== "") ||
      (draft.kind === "assignee" && draft.userId !== ""));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[480px] p-0 gap-0" showCloseButton={false}>
        <div className="px-5 py-4 border-b border-border/70">
          <DialogTitle className="text-[15px]">
            {editor.id ? "Edit quick action" : "New quick action"}
          </DialogTitle>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Open a page, a project board, or one person&apos;s assigned tasks.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onSubmit(draft);
          }}
        >
          <div className="px-5 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input
                value={draft.label}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
                placeholder="My open tasks"
                maxLength={80}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>Destination</Label>
              <Select
                value={draft.kind}
                onValueChange={(value) =>
                  value &&
                  setDraft((current) => ({
                    ...current,
                    kind: value as QuickAction["kind"],
                  }))
                }
                items={{
                  page: "Page or URL",
                  project: "Project board",
                  assignee: "Tasks by person",
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="page">Page or URL</SelectItem>
                  <SelectItem value="project">Project board</SelectItem>
                  <SelectItem value="assignee">Tasks by person</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {draft.kind === "page" && (
              <div className="space-y-1.5">
                <Label>Path or URL</Label>
                <Input
                  value={draft.url}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      url: event.target.value,
                    }))
                  }
                  placeholder="/analytics or https://example.com"
                />
              </div>
            )}

            {draft.kind === "project" && (
              <div className="space-y-1.5">
                <Label>Project</Label>
                <Select
                  value={draft.projectId}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      projectId: value ?? "",
                    }))
                  }
                  items={Object.fromEntries(
                    projects.map((project) => [String(project.id), project.name]),
                  )}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={String(project.id)}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {draft.kind === "assignee" && (
              <div className="space-y-1.5">
                <Label>Person</Label>
                <Select
                  value={draft.userId}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      userId: value ?? "",
                    }))
                  }
                  items={Object.fromEntries(
                    users.map((user) => [String(user.id), displayName(user)]),
                  )}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a person" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={String(user.id)}>
                        {displayName(user)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_ACTION_ICON_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        icon: option.value,
                      }))
                    }
                    className={cn(
                      "size-8 rounded-md border grid place-items-center transition-colors",
                      draft.icon === option.value
                        ? "border-foreground/30 bg-muted"
                        : "border-border hover:bg-muted/60",
                    )}
                    aria-label={`${option.label} icon`}
                  >
                    <QuickActionIcon
                      name={option.value}
                      className="size-3.5"
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="px-5 py-3 border-t border-border/70 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              {editor.id ? "Update action" : "Add action"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
