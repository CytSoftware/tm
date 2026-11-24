"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DescriptionEditor } from "./DescriptionEditor";
import { AssigneePicker, LabelPicker } from "./pickers";
import {
  RecurrencePicker,
  buildRrule,
  parseRruleToState,
  type RecurrenceState,
} from "./RecurrencePicker";
import { useLabelsQuery } from "@/hooks/use-labels";
import { useUsersQuery } from "@/hooks/use-users";
import { apiFetch } from "@/lib/api";
import { taskListKey } from "@/lib/query-keys";
import type {
  Project,
  Priority,
  RecurringTaskTemplate,
} from "@/lib/types";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "@/lib/types";

// TAS-057: the panel mounts bottom-anchored directly under wherever the
// mouse was when the triggering card was clicked. Its entry animation
// (`slide-in-from-bottom duration-300`) is purely visual — hit-testing sees
// the panel at its final position basically immediately, so the second
// pointerdown of a double-click on the card lands on whatever panel element
// is now under the cursor: a sidebar Select trigger (opens its dropdown) or
// the backdrop (closes the panel right after it opened). Guard against this
// with a plain timestamp ref rather than an `animationend` listener —
// reduced-motion users can skip/shorten the animation, which would leave an
// animationend-gated panel permanently inert.
const CLICK_THROUGH_GUARD_MS = 400;

type Props = {
  projects: Project[];
  /** Fallback project context when the template's project isn't loaded. */
  activeProject: Project | null;
  template: RecurringTaskTemplate;
  onClose: () => void;
};

/** Edits a recurring-task template. Tasks themselves (create and edit) use
 *  `TaskDetail`. */
export function TaskPanel({ projects, activeProject, template, onClose }: Props) {
  const queryClient = useQueryClient();
  const usersQuery = useUsersQuery();
  const users = usersQuery.data ?? [];

  // TAS-057 click-through guard: see comment above CLICK_THROUGH_GUARD_MS.
  // Initializing at first render (rather than in an effect) means the guard
  // is active from the very first paint, before any effect could run.
  const openedAtRef = useRef(performance.now());
  // Touch is exempt: the guard exists for the second pointerdown of a mouse
  // double-click, and there is no double-click-to-open on touch. Leaving it
  // armed there just swallowed the user's first real tap (TAS-061).
  const guardApplies =
    typeof window === "undefined" ||
    window.matchMedia("(pointer: fine)").matches;
  const withinClickThroughGuard = () =>
    guardApplies &&
    performance.now() - openedAtRef.current < CLICK_THROUGH_GUARD_MS;
  const clickThroughGuard = (e: {
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (!withinClickThroughGuard()) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // projectId === null means "Inbox" (projectless task). Templates always
  // have a project — they can't live in the Inbox.
  const initialProjectId: number | null =
    template.project ?? activeProject?.id ?? null;
  const [projectId, setProjectId] = useState<number | null>(initialProjectId);
  const selectedProject = useMemo(
    () =>
      projectId == null
        ? null
        : projects.find((p) => p.id === projectId) ?? activeProject,
    [projects, projectId, activeProject],
  );

  const [title, setTitle] = useState(template.title ?? "");
  const [description, setDescription] = useState(template.description ?? "");
  const [priority, setPriority] = useState<Priority | null>(
    template.priority ?? null,
  );
  const [storyPoints, setStoryPoints] = useState<string>(
    template.story_points != null ? String(template.story_points) : "",
  );
  const [assigneeIds, setAssigneeIds] = useState<number[]>(
    template.assignees.map((u) => u.id) ?? [],
  );
  const [labelIds, setLabelIds] = useState<number[]>(
    template.labels.map((l) => l.id) ?? [],
  );
  const allLabels = useLabelsQuery().data ?? [];
  // Controls pause/resume.
  const [active, setActive] = useState<boolean>(template.active);

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
      template.column?.id ??
      p.columns.find((c) => c.kind === "todo")?.id ??
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
    const currentColName = currentCol?.name;
    setColumnId(pickDefaultColumn(selectedProject, currentColName));
    // Drop labels scoped to another project. This also runs on mount, before
    // the labels query resolves — a label we can't resolve yet is kept, never
    // dropped, or opening and saving a task would wipe its labels (TAS-077).
    const knownLabels = new Map(
      [...(template.labels ?? []), ...allLabels].map((l) => [l.id, l]),
    );
    setLabelIds((prev) =>
      prev.filter((id) => {
        const scope = knownLabels.get(id)?.project;
        return scope == null || scope === selectedProject?.id;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id]);

  const [recurrence, setRecurrence] = useState<RecurrenceState>(() =>
    parseRruleToState(template.rrule, template.dtstart),
  );

  // Selectable labels: global ones plus the selected project's (Inbox: global only).
  const availableLabels = allLabels.filter(
    (l) => l.project == null || l.project === selectedProject?.id,
  );

  const updateRecurring = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch<RecurringTaskTemplate>(
        `/api/recurring-tasks/${template.id}/`,
        { method: "PATCH", body: payload },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
      if (template.project != null) {
        queryClient.invalidateQueries({
          queryKey: taskListKey(template.project),
        });
      }
    },
  });

  const deleteRecurring = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/recurring-tasks/${template.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
    },
  });

  const saving = updateRecurring.isPending;

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

  const canSubmit = !saving && !!title.trim();

  // Cmd/Ctrl+Enter submits the panel from anywhere — including when focus is
  // on a Select trigger or has escaped to <body> after a portalised dropdown
  // (Base UI's <Select> renders into a portal outside this component, so the
  // old `onKeyDown` on the panel root missed those events). A document-level
  // listener catches them regardless of where focus currently sits.
  //
  // ``handleSubmitRef`` is captured fresh each render so the listener always
  // uses the latest closure (canSubmit, recurrence state, etc.) without
  // re-binding on every keystroke.
  const handleSubmitRef = useRef<() => void>(() => {});
  handleSubmitRef.current = () => {
    if (canSubmit) void handleSubmit();
  };

  useEffect(() => {
    function onDocKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "Enter") return;
      e.preventDefault();
      handleSubmitRef.current();
    }
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, []);

  async function handleSubmit() {
    if (!title.trim()) return;
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
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete recurring template "${template.title}"?\n\nFuture instances will stop being generated. Tasks already created by this template are kept.`,
      )
    ) {
      return;
    }
    await deleteRecurring.mutateAsync();
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
        onClick={() => {
          // TAS-057: swallow the close if we're still inside the
          // click-through guard window — see CLICK_THROUGH_GUARD_MS.
          if (withinClickThroughGuard()) return;
          onClose();
        }}
      />

      {/* Panel — bottom-anchored, floating 1rem above the edge on desktop */}
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center pointer-events-none">
      <div
        className="pointer-events-auto w-full max-w-5xl h-[88dvh] lg:mb-4 flex flex-col rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-bottom duration-300 max-lg:h-dvh max-lg:rounded-none max-lg:border-0"
        onPointerDownCapture={clickThroughGuard}
        onMouseDownCapture={clickThroughGuard}
        onClickCapture={clickThroughGuard}
        onDoubleClickCapture={clickThroughGuard}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-2 px-6 py-3 border-b border-border/60 max-lg:px-3">
          <h2 className="text-[15px] font-semibold tracking-tight truncate min-w-0">
            Recurring — {template.title}
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Body — two columns on desktop: left properties sidebar, right
            title+description. On mobile the right pane becomes `display:
            contents` so its two children join the sidebar as siblings of one
            scrolling column, which lets `order` interleave them as
            title → properties → description. Properties sit above the editor
            because status/priority/assignee are the edits you actually make on
            a phone, and the editor is tall enough to bury them (TAS-061). */}
        <div className="flex-1 min-h-0 flex overflow-hidden max-lg:flex-col max-lg:overflow-y-auto">
          {/* Left: property sidebar */}
          <div className="w-64 shrink-0 border-r border-border/60 overflow-y-auto scrollbar-none p-4 space-y-1 max-lg:order-2 max-lg:w-full max-lg:border-r-0 max-lg:border-b max-lg:overflow-visible">
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

            <div className="flex items-start min-h-[32px] max-lg:flex-col max-lg:gap-0.5 max-lg:py-1">
              <span className="w-[72px] shrink-0 max-lg:w-full text-[12px] text-muted-foreground pl-1 pt-1.5 max-lg:pt-0">
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

            <div className="pt-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">
                Labels
              </span>
              <div className="mt-1">
                <LabelPicker
                  available={availableLabels}
                  selected={labelIds}
                  onChange={setLabelIds}
                  projectId={selectedProject?.id ?? null}
                />
              </div>
            </div>

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

          </div>

          {/* Right: title + description */}
          <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden max-lg:contents">
            <div className="shrink-0 px-6 pt-4 pb-2 max-lg:order-1 max-lg:px-4">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                autoFocus={
                  typeof window === "undefined" ||
                  window.matchMedia("(pointer: fine)").matches
                }
                className="text-[16px] font-medium border-0 bg-transparent px-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="flex-1 min-h-0 px-6 pb-4 max-lg:order-3 max-lg:flex-none max-lg:min-h-[45dvh] max-lg:px-4 max-lg:pt-4">
              <DescriptionEditor
                value={description}
                onChange={setDescription}
                onSubmit={() => {
                  if (canSubmit) void handleSubmit();
                }}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-border/60 flex items-center justify-end gap-2 max-lg:px-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
      </div>
    </>
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
    <div className="flex items-center min-h-[32px] max-lg:flex-col max-lg:items-stretch max-lg:gap-0.5 max-lg:py-1">
      <span className="w-[72px] shrink-0 max-lg:w-full text-[12px] text-muted-foreground pl-1">
        {label}
      </span>
      <div className="w-[160px] shrink-0 max-lg:w-full">{children}</div>
    </div>
  );
}

