"use client";

/**
 * Deal creation and the pipeline stage editor.
 *
 * The stage editor follows the TAS-069 column-editor contract: edit the whole
 * list locally, then one Save sends it as a single ordered PUT. The server
 * refuses to drop a stage that still holds deals.
 */

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type Pipeline,
  type StageKind,
  useContacts,
  useCreateDeal,
  useCreatePipeline,
  useDeletePipeline,
  usePipelines,
  useUpdatePipeline,
} from "@/hooks/use-crm";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useUsersQuery } from "@/hooks/use-users";
import { STAGE_KIND_LABEL, errorMessage, userLabel } from "@/lib/crm-meta";

import { inputCls } from "./shared";

export type NewDealDefaults = {
  pipeline?: number;
  stage?: number;
  company?: { id: number; name: string } | null;
};

export function NewDealDialog({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: NewDealDefaults | null;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  return (
    <Dialog open={defaults != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {defaults && <NewDealBody defaults={defaults} onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function NewDealBody({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: NewDealDefaults;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const pipelines = usePipelines();
  const companies = useContacts({ kind: "company", relationship: "any", sort: "name" });
  const projects = useProjectsQuery({ includeArchived: false });
  const users = useUsersQuery();
  const create = useCreateDeal();

  const [pipelineId, setPipelineId] = useState<number | null>(
    defaults.pipeline ?? null,
  );
  const pipeline =
    pipelines.data?.find((p) => p.id === pipelineId) ?? pipelines.data?.[0];
  const [stageId, setStageId] = useState<number | null>(defaults.stage ?? null);
  const [title, setTitle] = useState(defaults.company ? `${defaults.company.name} — ` : "");
  const [company, setCompany] = useState<string>(defaults.company ? String(defaults.company.id) : "");
  const [value, setValue] = useState("");
  const [owner, setOwner] = useState("");
  const [product, setProduct] = useState("");
  const [close, setClose] = useState("");

  const stages = pipeline?.stages ?? [];
  const stage = stages.find((s) => s.id === stageId) ?? stages.find((s) => s.kind === "open");

  const submit = () => {
    if (!pipeline || !title.trim()) return;
    create.mutate(
      {
        title: title.trim(),
        pipeline: pipeline.id,
        stage: stage?.id,
        company: company ? Number(company) : null,
        value: value.trim() || null,
        owner: owner ? Number(owner) : null,
        product_project: product ? Number(product) : null,
        expected_close: close || null,
      },
      {
        onSuccess: (d) => {
          toast.success(`${d.key} created`);
          onClose();
          onCreated(d.key);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-[14px]">New deal</DialogTitle>
      </DialogHeader>
      <div className="mt-3 space-y-2.5">
        <Field label="Title">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="ECG — Mowafeq pilot"
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Pipeline">
            <select
              value={pipeline?.id ?? ""}
              onChange={(e) => {
                setPipelineId(Number(e.target.value));
                setStageId(null);
              }}
              className={inputCls}
            >
              {(pipelines.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stage">
            <select
              value={stage?.id ?? ""}
              onChange={(e) => setStageId(Number(e.target.value))}
              className={inputCls}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Company">
          <select value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {(companies.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Value (QAR)">
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="75000"
              className={inputCls}
            />
          </Field>
          <Field label="Expected close">
            <input type="date" value={close} onChange={(e) => setClose(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Product">
            <select value={product} onChange={(e) => setProduct(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {(projects.data?.results ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Owner">
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls}>
              <option value="">No owner</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {userLabel(u)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending || !title.trim() || !pipeline}>
          {create.isPending ? "Creating…" : "Create deal"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── Pipeline editor ─────────────────────────────────────────────────────────

type DraftStage = { id?: number; name: string; kind: StageKind; deal_count: number };

export function PipelineEditorDialog({
  pipeline,
  open,
  onOpenChange,
  onSelectPipeline,
}: {
  pipeline: Pipeline | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSelectPipeline: (id: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && (
          <PipelineEditorBody
            key={pipeline?.id ?? "new"}
            pipeline={pipeline}
            onClose={() => onOpenChange(false)}
            onSelectPipeline={onSelectPipeline}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PipelineEditorBody({
  pipeline,
  onClose,
  onSelectPipeline,
}: {
  pipeline: Pipeline | null;
  onClose: () => void;
  onSelectPipeline: (id: number) => void;
}) {
  const update = useUpdatePipeline();
  const create = useCreatePipeline();
  const remove = useDeletePipeline();
  const [name, setName] = useState(pipeline?.name ?? "");
  const [stages, setStages] = useState<DraftStage[]>(
    () =>
      pipeline?.stages.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        deal_count: s.deal_count,
      })) ?? [],
  );
  const dirty = useMemo(() => {
    if (!pipeline) return true;
    if (name.trim() !== pipeline.name) return true;
    return (
      JSON.stringify(stages.map(({ id, name, kind }) => ({ id, name, kind }))) !==
      JSON.stringify(pipeline.stages.map(({ id, name, kind }) => ({ id, name, kind })))
    );
  }, [pipeline, name, stages]);

  const patch = (i: number, p: Partial<DraftStage>) =>
    setStages((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const swap = (i: number, j: number) =>
    setStages((s) => {
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = () => {
    const onError = (e: unknown) => toast.error(errorMessage(e));
    if (!pipeline) {
      create.mutate(
        { name: name.trim() },
        {
          onSuccess: (p) => {
            onSelectPipeline(p.id);
            onClose();
          },
          onError,
        },
      );
      return;
    }
    update.mutate(
      {
        id: pipeline.id,
        name: name.trim() !== pipeline.name ? name.trim() : undefined,
        stages: stages.map(({ id, name, kind }) => ({ id, name: name.trim(), kind })),
      },
      { onSuccess: () => onClose(), onError },
    );
  };

  return (
    <div>
      <DialogHeader>
        <DialogTitle className="text-[14px]">
          {pipeline ? `Edit ${pipeline.name}` : "New pipeline"}
        </DialogTitle>
      </DialogHeader>
      <div className="mt-3 space-y-3">
        <Field label="Name">
          <input
            autoFocus={!pipeline}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Partnerships"
            className={inputCls}
          />
        </Field>
        {pipeline ? (
          <div>
            <span className="mb-1 block text-[11px] text-muted-foreground">Stages</span>
            <ul className="space-y-1">
              {stages.map((s, i) => (
                <li key={s.id ?? `new-${i}`} className="flex items-center gap-1">
                  <input
                    value={s.name}
                    onChange={(e) => patch(i, { name: e.target.value })}
                    className={inputCls}
                  />
                  <select
                    value={s.kind}
                    onChange={(e) => patch(i, { kind: e.target.value as StageKind })}
                    className="h-8 shrink-0 rounded-md border border-border bg-transparent px-1 text-[12px]"
                  >
                    {(Object.keys(STAGE_KIND_LABEL) as StageKind[]).map((k) => (
                      <option key={k} value={k}>
                        {STAGE_KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <IconBtn label="Move up" onClick={() => swap(i, i - 1)} disabled={i === 0}>
                    <ArrowUp className="size-3.5" />
                  </IconBtn>
                  <IconBtn label="Move down" onClick={() => swap(i, i + 1)} disabled={i === stages.length - 1}>
                    <ArrowDown className="size-3.5" />
                  </IconBtn>
                  <IconBtn
                    label={s.deal_count ? `${s.deal_count} deals — move them first` : "Remove stage"}
                    onClick={() => setStages((x) => x.filter((_, j) => j !== i))}
                    disabled={s.deal_count > 0}
                  >
                    <Trash2 className="size-3.5" />
                  </IconBtn>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                setStages((s) => {
                  // New stages go before the first closed one.
                  const at = s.findIndex((x) => x.kind !== "open");
                  const next = [...s];
                  next.splice(at < 0 ? s.length : at, 0, { name: "New stage", kind: "open", deal_count: 0 });
                  return next;
                })
              }
              className="mt-1.5 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3.5" /> Add stage
            </button>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Starts with New → Won · Lost. Edit the stages after creating it.
          </p>
        )}
      </div>
      <DialogFooter className="mt-4">
        {pipeline && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto text-destructive"
            disabled={stages.some((s) => s.deal_count > 0) || remove.isPending}
            title={stages.some((s) => s.deal_count > 0) ? "Move or delete its deals first" : undefined}
            onClick={() =>
              remove.mutate(pipeline.id, {
                onSuccess: () => onClose(),
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            Delete pipeline
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={!dirty || !name.trim() || update.isPending || create.isPending}
        >
          {pipeline ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="tap-target grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
