"use client";

/** One deal: stage, money, who's on it, what we owe them, what happened. */

import { useState } from "react";
import { Building2, Plus, Trash2, User as UserIcon, X } from "lucide-react";
import { toast } from "sonner";

import {
  type DealDetail as Detail,
  type DealWrite,
  useDeal,
  useDeleteDeal,
  usePipelines,
  useUpdateDeal,
} from "@/hooks/use-crm";
import { useUsersQuery } from "@/hooks/use-users";
import {
  TOUCHPOINT_META,
  errorMessage,
  formatMoney,
  shortDate,
  userLabel,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { FollowUpRow, QuickFollowUp } from "./InboxView";
import { SectionHeader, controlCls, ghostBtnCls } from "./shared";

export function DealDetail({
  dealKey,
  onClose,
  onOpenContact,
}: {
  dealKey: string;
  onClose: () => void;
  onOpenContact: (id: number) => void;
}) {
  const deal = useDeal(dealKey);
  if (deal.isLoading) return <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>;
  if (deal.isError || !deal.data)
    return (
      <div className="p-4 text-[13px] text-destructive">
        {errorMessage(deal.error) || "Couldn’t load this deal."}
      </div>
    );
  return <Body deal={deal.data} onClose={onClose} onOpenContact={onOpenContact} />;
}

function Body({
  deal: d,
  onClose,
  onOpenContact,
}: {
  deal: Detail;
  onClose: () => void;
  onOpenContact: (id: number) => void;
}) {
  const update = useUpdateDeal();
  const remove = useDeleteDeal();
  const pipelines = usePipelines();
  const users = useUsersQuery();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(d.title);
  const [value, setValue] = useState(d.value ?? "");
  const [notes, setNotes] = useState(d.notes);

  const stages = pipelines.data?.find((p) => p.id === d.pipeline.id)?.stages ?? [];
  const save = (patch: DealWrite) =>
    update.mutate({ key: d.key, ...patch }, { onError: (e) => toast.error(errorMessage(e)) });
  const followUpEntity = d.contacts[0]?.id ?? d.company?.id;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="font-mono">{d.key}</span>
              <span>· {d.pipeline.name}</span>
              {d.closed_at && <span>· closed {shortDate(d.closed_at)}</span>}
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== d.title && save({ title: title.trim() })}
              className="mt-0.5 w-full bg-transparent text-[16px] font-semibold leading-snug outline-none"
            />
          </div>
          <button
            type="button"
            aria-label="Delete deal"
            onClick={() => {
              if (!window.confirm(`Delete ${d.key}? Its follow-ups stay as tasks.`)) return;
              remove.mutate(d.key, {
                onSuccess: onClose,
                onError: (e) => toast.error(errorMessage(e)),
              });
            }}
            className="tap-target grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="tap-target -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-lg:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Stage"
            value={d.stage.id}
            onChange={(e) => save({ stage: Number(e.target.value) })}
            className={cn(
              controlCls,
              "h-6 font-medium",
              d.stage.kind === "won" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
              d.stage.kind === "lost" && "text-muted-foreground",
            )}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Owner"
            value={d.owner?.id ?? ""}
            onChange={(e) => save({ owner: e.target.value ? Number(e.target.value) : null })}
            className={cn(controlCls, "h-6")}
          >
            <option value="">No owner</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {userLabel(u)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
            {d.currency}
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
              onBlur={() => value !== (d.value ?? "") && save({ value: value || null })}
              placeholder="value"
              className="h-6 w-24 rounded-md border border-border bg-transparent px-1.5 text-[12px] tabular-nums text-foreground outline-none focus-visible:border-ring"
            />
          </label>
          <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
            close
            <input
              type="date"
              value={d.expected_close ?? ""}
              onChange={(e) => save({ expected_close: e.target.value || null })}
              className="h-6 rounded-md border border-border bg-transparent px-1 text-[12px] text-foreground"
            />
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {d.company && (
            <button
              type="button"
              onClick={() => onOpenContact(d.company!.id)}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted px-2 text-[12px] hover:border-foreground/40"
            >
              <Building2 className="size-3" /> {d.company.name}
            </button>
          )}
          {d.contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpenContact(c.id)}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[12px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            >
              <UserIcon className="size-3" /> {c.name}
            </button>
          ))}
          {d.value && (
            <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">
              {formatMoney(d.value, d.currency)}
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <SectionHeader
          title="Follow-ups"
          count={d.follow_ups.filter((f) => f.is_open).length}
          action={
            followUpEntity &&
            !adding && (
              <button type="button" className={ghostBtnCls} onClick={() => setAdding(true)}>
                <Plus className="size-3.5" /> Add
              </button>
            )
          }
        />
        {adding && followUpEntity && (
          <div className="px-4 pb-2">
            <QuickFollowUp entityId={followUpEntity} dealKey={d.key} onDone={() => setAdding(false)} />
          </div>
        )}
        {d.follow_ups.length > 0 ? (
          <ul className="divide-y divide-border/60">
            {d.follow_ups.map((f) => (
              <FollowUpRow key={f.id} followUp={f} onOpenContact={onOpenContact} />
            ))}
          </ul>
        ) : (
          <p className="px-4 text-[12px] text-muted-foreground">
            {followUpEntity ? "None yet." : "Add a company or contact to file follow-ups."}
          </p>
        )}

        <SectionHeader title="Notes" />
        <div className="px-4">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== d.notes && save({ notes })}
            rows={4}
            placeholder="Scope, pricing, blockers… (the long story belongs in the wiki)"
            className="block w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring"
          />
        </div>
        {d.stage.kind === "lost" && (
          <div className="px-4 pt-2">
            <input
              defaultValue={d.lost_reason}
              onBlur={(e) => e.target.value !== d.lost_reason && save({ lost_reason: e.target.value })}
              placeholder="Why was it lost?"
              className="h-7 w-full rounded-md border border-border bg-transparent px-2 text-[12px] outline-none focus-visible:border-ring"
            />
          </div>
        )}

        <SectionHeader title="Touchpoints" count={d.touchpoints.length} />
        {d.touchpoints.length > 0 ? (
          <ul className="space-y-2 px-4">
            {d.touchpoints.map((t) => {
              const Icon = TOUCHPOINT_META[t.kind].icon;
              return (
                <li key={t.id} className="flex gap-2 text-[13px]">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">
                      {shortDate(t.occurred_at)} · {t.entities.map((e) => e.name).join(", ")}
                    </div>
                    <p className="whitespace-pre-wrap" dir="auto">{t.summary}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 text-[12px] text-muted-foreground">
            Touches logged against this deal show up here.
          </p>
        )}
      </div>
    </div>
  );
}
