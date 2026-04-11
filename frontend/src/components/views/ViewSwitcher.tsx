"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, Check, LayoutGrid, List, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { projectsKey, usersKey, viewsKey } from "@/lib/query-keys";
import type {
  SavedView,
  ViewListResponse,
  ProjectListResponse,
  Project,
  User,
  Priority,
  CardField,
  Label as LabelType,
} from "@/lib/types";
import {
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  ALL_CARD_FIELDS,
  CARD_FIELD_LABELS,
  SORT_FIELDS,
  SORT_FIELD_LABELS,
  type SortField,
} from "@/lib/types";

type Props = {
  projectId: number | null;
  viewId: number | null;
  onViewChange: (id: number | null) => void;
};

export function ViewSwitcher({ projectId, viewId, onViewChange }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingView, setEditingView] = useState<SavedView | null>(null);
  const qc = useQueryClient();

  const viewsQuery = useQuery({
    queryKey: viewsKey(),
    queryFn: () => apiFetch<ViewListResponse>("/api/views/"),
  });

  const deleteView = useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/views/${id}/`, { method: "DELETE" }),
    onSuccess: (_data, deletedId) => {
      qc.invalidateQueries({ queryKey: viewsKey() });
      if (viewId === deletedId) onViewChange(null);
    },
  });

  const allViews: SavedView[] = viewsQuery.data?.results ?? [];
  const views = projectId
    ? allViews.filter((v) => !v.project || v.project === projectId)
    : allViews;

  const activeView = views.find((v) => v.id === viewId);

  const viewIcon =
    activeView?.kind === "table" ? (
      <List className="size-3.5 text-muted-foreground" />
    ) : (
      <LayoutGrid className="size-3.5 text-muted-foreground" />
    );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-40 justify-between text-[13px]"
            >
              {viewIcon}
              {activeView ? activeView.name : "All tasks"}
              <ChevronDown className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Views
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onViewChange(null)}>
              {!viewId && <Check className="size-3.5" />}
              <span className={viewId ? "ml-5" : ""}>All tasks</span>
            </DropdownMenuItem>
            {views.map((v) => (
              <DropdownMenuItem
                key={v.id}
                className="flex items-center justify-between group/view"
                onClick={() => onViewChange(v.id)}
              >
                <div className="flex items-center gap-0 min-w-0">
                  {viewId === v.id && <Check className="size-3.5 shrink-0" />}
                  <span className={viewId === v.id ? "" : "ml-5"}>
                    {v.kind === "table" ? (
                      <List className="inline size-3 mr-1 text-muted-foreground" />
                    ) : (
                      <LayoutGrid className="inline size-3 mr-1 text-muted-foreground" />
                    )}
                    {v.name}
                    {v.shared && (
                      <span className="text-[10px] text-muted-foreground ml-1">
                        (shared)
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover/view:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingView(v);
                    }}
                    className="size-6 grid place-items-center rounded hover:bg-accent transition-colors"
                    aria-label={`Edit ${v.name}`}
                  >
                    <Pencil className="size-3 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete view "${v.name}"?`))
                        deleteView.mutate(v.id);
                    }}
                    className="size-6 grid place-items-center rounded hover:bg-destructive/10 transition-colors"
                    aria-label={`Delete ${v.name}`}
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </button>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialogOpen(true)}>
            <Plus className="size-3.5" />
            New view
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogOpen && (
        <NewViewDialog
          currentProjectId={projectId}
          onSaved={(id) => {
            setDialogOpen(false);
            onViewChange(id);
          }}
          onClose={() => setDialogOpen(false)}
        />
      )}
      {editingView && (
        <NewViewDialog
          currentProjectId={projectId}
          existingView={editingView}
          onSaved={(id) => {
            setEditingView(null);
            onViewChange(id);
          }}
          onClose={() => setEditingView(null)}
        />
      )}
    </>
  );
}

function NewViewDialog({
  currentProjectId,
  existingView,
  onSaved,
  onClose,
}: {
  currentProjectId: number | null;
  existingView?: SavedView;
  onSaved: (id: number) => void;
  onClose: () => void;
}) {
  const isEdit = !!existingView;
  const qc = useQueryClient();
  const [name, setName] = useState(existingView?.name ?? "");
  const [viewKind, setViewKind] = useState<"board" | "table">(existingView?.kind ?? "board");
  const [filterProjectId, setFilterProjectId] = useState<number | null>(
    existingView?.project ?? currentProjectId,
  );
  const [priorities, setPriorities] = useState<Priority[]>(
    (existingView?.filters?.priority as Priority[]) ?? [],
  );
  const [assigneeIds, setAssigneeIds] = useState<number[]>(
    ((existingView?.filters?.assignee as (string | number)[]) ?? []).map(Number),
  );
  const [labelIds, setLabelIds] = useState<number[]>(
    ((existingView?.filters?.labels as (string | number)[]) ?? []).map(Number),
  );
  const [shared, setShared] = useState(existingView?.shared ?? false);
  const [sortField, setSortField] = useState<SortField>(
    (existingView?.sort?.[0]?.field as SortField) ?? "updated_at",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">(
    existingView?.sort?.[0]?.dir ?? "desc",
  );
  const [cardFields, setCardFields] = useState<CardField[]>(
    existingView?.card_display ?? [...ALL_CARD_FIELDS],
  );

  const projectsQuery = useQuery({
    queryKey: projectsKey(),
    queryFn: () => apiFetch<ProjectListResponse>("/api/projects/"),
  });
  const projects: Project[] = projectsQuery.data?.results ?? [];

  const usersQuery = useQuery({
    queryKey: usersKey(),
    queryFn: () => apiFetch<User[]>("/api/users/"),
  });
  const users: User[] = usersQuery.data ?? [];

  const labelsQuery = useQuery({
    queryKey: ["labels", filterProjectId ?? "all"],
    queryFn: () =>
      apiFetch<LabelType[]>(
        filterProjectId
          ? `/api/projects/${filterProjectId}/labels/`
          : `/api/labels/`,
      ),
  });
  const labels: LabelType[] = labelsQuery.data ?? [];

  const projectItems = useMemo(
    () => ({
      "": "All projects",
      ...Object.fromEntries(
        projects.map((p) => [String(p.id), `${p.name} (${p.prefix})`]),
      ),
    }),
    [projects],
  );
  const sortFieldItems = SORT_FIELD_LABELS;
  const sortDirItems = { asc: "Ascending", desc: "Descending" };
  const viewKindItems = { board: "Board", table: "List" };

  const createView = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch<SavedView>("/api/views/", { method: "POST", body: payload }),
    onSuccess: (view) => {
      qc.invalidateQueries({ queryKey: viewsKey() });
      onSaved(view.id);
    },
  });

  const updateView = useMutation({
    mutationFn: (payload: unknown) =>
      apiFetch<SavedView>(`/api/views/${existingView!.id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: (view) => {
      qc.invalidateQueries({ queryKey: viewsKey() });
      onSaved(view.id);
    },
  });

  const saving = createView.isPending || updateView.isPending;

  function toggleCardField(field: CardField) {
    setCardFields((prev) =>
      prev.includes(field)
        ? prev.filter((f) => f !== field)
        : [...prev, field],
    );
  }

  const allFieldsSelected = cardFields.length === ALL_CARD_FIELDS.length;

  function handleSave() {
    if (!name.trim()) return;
    const filters: Record<string, unknown> = {};
    if (filterProjectId) filters.project = filterProjectId;
    if (priorities.length > 0) filters.priority = priorities;
    if (assigneeIds.length > 0) filters.assignee = assigneeIds;
    if (labelIds.length > 0) filters.labels = labelIds;
    const payload = {
      name,
      project: filterProjectId,
      kind: viewKind,
      filters,
      sort: [{ field: sortField, dir: sortDir }],
      shared,
      card_display: allFieldsSelected ? null : cardFields,
    };
    if (isEdit) {
      updateView.mutate(payload);
    } else {
      createView.mutate(payload);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 flex flex-col overflow-hidden max-h-[85vh]"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            {isEdit ? "Edit view" : "New view"}
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {isEdit
              ? "Update this view's filters, sort, and display settings."
              : "Save a filtered + sorted view of the board."}
          </p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none px-5 py-4 space-y-3">
          {/* Name + View type — side by side */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="High priority, mine"
                autoFocus
                className="h-9 text-[13px]"
              />
            </Field>
            <Field label="View type">
              <Select
                value={viewKind}
                onValueChange={(v) => setViewKind(v as "board" | "table")}
                items={viewKindItems}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="board">Board</SelectItem>
                  <SelectItem value="table">List</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Project — full width */}
          <Field label="Project">
            <Select
              value={filterProjectId != null ? String(filterProjectId) : ""}
              onValueChange={(v) =>
                setFilterProjectId(v === "" ? null : Number(v))
              }
              items={projectItems}
            >
              <SelectTrigger className="h-9 text-[13px]">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name} ({p.prefix})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* Priority + Assignees — side by side */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority">
              <div className="flex flex-wrap gap-1.5">
                {PRIORITY_ORDER.map((p) => {
                  const active = priorities.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() =>
                        setPriorities(
                          active
                            ? priorities.filter((x) => x !== p)
                            : [...priorities, p],
                        )
                      }
                      className={`rounded border px-2 py-1 text-[12px] transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:border-foreground/30"
                      }`}
                    >
                      {PRIORITY_LABELS[p]}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Assignees">
              <div className="flex flex-wrap gap-1.5">
                {users.map((u) => {
                  const active = assigneeIds.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() =>
                        setAssigneeIds(
                          active
                            ? assigneeIds.filter((x) => x !== u.id)
                            : [...assigneeIds, u.id],
                        )
                      }
                      className={`rounded border px-2 py-1 text-[12px] transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:border-foreground/30"
                      }`}
                    >
                      {u.username}
                    </button>
                  );
                })}
                {users.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    No users found.
                  </span>
                )}
              </div>
            </Field>
          </div>

          {/* Labels — full width */}
          {labels.length > 0 && (
            <Field label="Labels">
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => {
                  const active = labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() =>
                        setLabelIds(
                          active
                            ? labelIds.filter((x) => x !== l.id)
                            : [...labelIds, l.id],
                        )
                      }
                      className="rounded border px-2 py-1 text-[12px] transition-colors"
                      style={{
                        background: active ? `${l.color}30` : undefined,
                        color: active ? l.color : undefined,
                        borderColor: active ? `${l.color}60` : undefined,
                      }}
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          {/* Sort by + Direction — side by side */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sort by">
              <Select
                value={sortField}
                onValueChange={(v) => setSortField(v as SortField)}
                items={sortFieldItems}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_FIELDS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {SORT_FIELD_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Direction">
              <Select
                value={sortDir}
                onValueChange={(v) => setSortDir(v as "asc" | "desc")}
                items={sortDirItems}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">Ascending</SelectItem>
                  <SelectItem value="desc">Descending</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Card fields + Shared — side by side */}
          <div className="grid grid-cols-2 gap-3">
            {viewKind === "board" && (
              <Field label="Card fields">
                <div className="grid grid-cols-2 gap-1">
                  {ALL_CARD_FIELDS.map((field) => {
                    const active = cardFields.includes(field);
                    return (
                      <button
                        key={field}
                        type="button"
                        className={cn(
                          "flex items-center gap-2 rounded px-2 py-1.5 text-[12px] transition-colors",
                          active
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/50",
                        )}
                        onClick={() => toggleCardField(field)}
                      >
                        <div
                          className={cn(
                            "size-3.5 rounded-sm border flex items-center justify-center text-[9px]",
                            active
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-input",
                          )}
                        >
                          {active && "✓"}
                        </div>
                        {CARD_FIELD_LABELS[field]}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            <div className={cn("flex items-stretch", viewKind !== "board" && "col-span-2")}>
              <div className="flex items-center justify-between rounded-md border border-border/80 p-3 w-full">
                <div>
                  <span className="text-[13px] font-medium">
                    Shared with everyone
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    Other users will see this view in their view picker.
                  </p>
                </div>
                <Switch checked={shared} onCheckedChange={setShared} />
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving ? "Saving..." : isEdit ? "Update view" : "Save view"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
    <div className="space-y-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
