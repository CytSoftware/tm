"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeleteColumnDialog } from "@/components/kanban/DeleteColumnDialog";
import { useCreateColumn, useDeleteColumn, useReorderColumns, useUpdateColumn } from "@/hooks/use-columns";
import { useProjectsQuery } from "@/hooks/use-projects";
import { apiFetch, ApiError } from "@/lib/api";
import { COLUMN_KIND_LABELS, COLUMN_KIND_ORDER } from "@/lib/types";
import type { Column, ColumnKind, Project } from "@/lib/types";

function showError(error: Error) {
  const payload = error instanceof ApiError ? error.payload : null;
  toast.error(payload ? Object.values(payload).flat().join(" · ") : error.message);
}

function KindSelect({ value, onChange, label }: { value: ColumnKind; onChange: (kind: ColumnKind) => void; label: string }) {
  return <select aria-label={label} value={value} onChange={e => onChange(e.target.value as ColumnKind)} className="h-8 rounded-md border bg-background px-2 text-xs">
    {COLUMN_KIND_ORDER.map(kind => <option key={kind} value={kind}>{COLUMN_KIND_LABELS[kind]}</option>)}
  </select>;
}

export function ProjectColumns({ project }: { project: Project }) {
  const create = useCreateColumn();
  const update = useUpdateColumn();
  const remove = useDeleteColumn();
  const reorder = useReorderColumns();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ColumnKind>("other");
  const [checkingDelete, setCheckingDelete] = useState(false);
  const [deleting, setDeleting] = useState<{ column: Column; count: number } | null>(null);
  const columns = [...project.columns].sort((a, b) => a.order - b.order);
  const busy = create.isPending || update.isPending || remove.isPending || reorder.isPending || checkingDelete;

  async function requestDelete(column: Column) {
    setCheckingDelete(true);
    try {
      const data = await apiFetch<{ count: number }>("/api/tasks/", { query: { project: project.id, column: column.id, limit: 1 } });
      setDeleting({ column, count: data.count });
    } catch (error) { showError(error as Error); }
    finally { setCheckingDelete(false); }
  }

  function move(index: number, direction: number) {
    const ids = columns.map(c => c.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    reorder.mutate({ project: project.id, ordered_ids: ids }, { onError: showError });
  }

  return <section className="space-y-3 rounded-lg border p-4">
    <div>
      <h2 className="text-sm font-medium">Project columns</h2>
      <p className="text-xs text-muted-foreground">The type controls where tasks appear in All Projects. Changes save here independently.</p>
    </div>
    <fieldset disabled={busy} className="space-y-2 disabled:opacity-60">
      {columns.map((column, index) => <ColumnRow
        key={`${column.id}:${column.name}:${column.kind}`}
        column={column}
        onSave={(name, kind) => update.mutate({ id: column.id, name, kind }, { onError: showError })}
        onDelete={() => void requestDelete(column)}
        onMove={direction => move(index, direction)}
        first={index === 0}
        last={index === columns.length - 1}
      />)}
      <form className="flex flex-wrap items-center gap-2 border-t pt-3" onSubmit={e => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        create.mutate({ project: project.id, name: name.trim(), kind }, {
          onSuccess: () => { setName(""); setKind("other"); }, onError: showError,
        });
      }}>
        <Input aria-label="New column name" placeholder="New column name" maxLength={80} value={name} onChange={e => setName(e.target.value)} className="h-8 min-w-32 flex-1 text-xs" />
        <KindSelect label="New column type" value={kind} onChange={setKind} />
        <Button type="submit" size="sm" className="h-8" disabled={!name.trim()}>Add column</Button>
      </form>
    </fieldset>
    <DeleteColumnDialog
      open={deleting !== null}
      column={deleting?.column ?? null}
      siblings={columns.filter(c => c.id !== deleting?.column.id)}
      taskCount={deleting?.count ?? 0}
      isPending={remove.isPending}
      onCancel={() => { if (!remove.isPending) setDeleting(null); }}
      onConfirm={moveTasksTo => {
        if (!deleting) return;
        remove.mutate({ id: deleting.column.id, projectId: project.id, moveTasksTo }, {
          onSuccess: () => setDeleting(null), onError: showError,
        });
      }}
    />
  </section>;
}

function ColumnRow({ column, onSave, onDelete, onMove, first, last }: {
  column: Column; onSave: (name: string, kind: ColumnKind) => void;
  onDelete: () => void; onMove: (direction: number) => void; first: boolean; last: boolean;
}) {
  const [name, setName] = useState(column.name);
  const [kind, setKind] = useState(column.kind);
  return <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if (name.trim()) onSave(name.trim(), kind); }}>
    <Input aria-label={`Name for ${column.name}`} maxLength={80} value={name} onChange={e => setName(e.target.value)} className="h-8 min-w-32 flex-1 text-xs" />
    <KindSelect label={`Type for ${column.name}`} value={kind} onChange={setKind} />
    <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!name.trim() || (name.trim() === column.name && kind === column.kind)}>Save</Button>
    <div className="flex">
      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Move ${column.name} up`} disabled={first} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></Button>
      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Move ${column.name} down`} disabled={last} onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></Button>
      <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive" aria-label={`Delete ${column.name}`} onClick={onDelete}><Trash2 className="size-3.5" /></Button>
    </div>
  </form>;
}

export function ProjectColumnSettings() {
  const query = useProjectsQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const projects = query.data?.results ?? [];
  const project = projects.find(p => p.id === selectedId) ?? projects[0];
  if (query.isPending) return <p role="status">Loading projects…</p>;
  if (query.isError) return <p role="alert">Couldn’t load project columns.</p>;
  if (!project) return <p>Create a project to manage its columns.</p>;
  return <div className="space-y-3">
    <label className="flex items-center gap-3 text-sm">Project
      <select value={project.id} onChange={e => setSelectedId(Number(e.target.value))} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2">
        {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? " (archived)" : ""}</option>)}
      </select>
    </label>
    <ProjectColumns key={project.id} project={project} />
  </div>;
}
