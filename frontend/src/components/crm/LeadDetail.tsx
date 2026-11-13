"use client";

/**
 * One lead, laid out like an issue thread: a header with where it stands and
 * what's owed (pinned), the standing context as its description, then the
 * updates oldest → newest with the composer fixed at the bottom.
 */

import { useEffect, useRef, useState } from "react";
import { Building2, Trash2, User as UserIcon, X } from "lucide-react";
import { toast } from "sonner";

import {
  type LeadDetail as Detail,
  type LeadStage,
  type LeadWrite,
  type LostReason,
  useContacts,
  useDeleteLead,
  useLead,
  usePayments,
  useUpdateLead,
} from "@/hooks/use-crm";
import { useProjectsQuery } from "@/hooks/use-projects";
import {
  LOST_REASONS,
  STAGES,
  errorMessage,
  money,
  shortDate,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { PaymentRow } from "./BillingView";
import { LicencesBlock } from "./LicencesView";
import { PaymentDialog, type PaymentDraft } from "./PaymentDialog";
import { StepRow } from "./StepRow";
import { UpdateComposer } from "./UpdateComposer";
import { UpdateFeed } from "./UpdateFeed";
import { SectionHeader, controlCls, ghostBtnCls } from "./shared";

export function LeadDetail({
  leadKey,
  onClose,
  onOpenContact,
}: {
  leadKey: string;
  onClose: () => void;
  onOpenContact: (id: number) => void;
}) {
  const lead = useLead(leadKey);
  if (lead.isLoading) return <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>;
  if (lead.isError || !lead.data)
    return (
      <div className="p-4 text-[13px] text-destructive">
        {errorMessage(lead.error) || "Couldn’t load this lead."}
      </div>
    );
  return <Body lead={lead.data} onClose={onClose} onOpenContact={onOpenContact} />;
}

function Body({
  lead: l,
  onClose,
  onOpenContact,
}: {
  lead: Detail;
  onClose: () => void;
  onOpenContact: (id: number) => void;
}) {
  const update = useUpdateLead();
  const remove = useDeleteLead();
  const projects = useProjectsQuery({ includeArchived: false });
  const companies = useContacts({ kind: "company", all: "1" });
  const [title, setTitle] = useState(l.title);
  const [notes, setNotes] = useState(l.notes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = l.updates.length;

  // A thread opens at its newest entry, and follows new posts.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [l.key, count]);

  const save = (patch: LeadWrite) =>
    update.mutate({ key: l.key, ...patch }, { onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="font-mono">{l.key}</span>
              {l.closed_at && <span>· closed {shortDate(l.closed_at)}</span>}
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== l.title && save({ title: title.trim() })}
              className="mt-0.5 w-full bg-transparent text-[16px] font-semibold leading-snug outline-none"
            />
          </div>
          <button
            type="button"
            aria-label="Delete lead"
            onClick={() => {
              if (!window.confirm(`Delete ${l.key}? Its updates stay in Activity and its next steps stay as tasks.`))
                return;
              remove.mutate(l.key, { onSuccess: onClose, onError: (e) => toast.error(errorMessage(e)) });
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
            value={l.stage}
            onChange={(e) => save({ stage: e.target.value as LeadStage })}
            className={cn(
              controlCls,
              "h-6 font-medium",
              l.stage === "won" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
              l.stage === "lost" && "text-muted-foreground",
            )}
          >
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Project"
            value={l.project?.id ?? ""}
            onChange={(e) => save({ project: e.target.value ? Number(e.target.value) : null })}
            className={cn(controlCls, "h-6")}
          >
            <option value="">No project</option>
            {(projects.data?.results ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {l.company ? (
            <button
              type="button"
              onClick={() => onOpenContact(l.company!.id)}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted px-2 text-[12px] hover:border-foreground/40"
            >
              <Building2 className="size-3" /> {l.company.name}
            </button>
          ) : (
            <select
              aria-label="Company"
              value=""
              onChange={(e) => e.target.value && save({ company: Number(e.target.value) })}
              className={cn(controlCls, "h-6 border-dashed")}
            >
              <option value="">+ Company…</option>
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {l.people.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpenContact(p.id)}
              title={p.position || undefined}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[12px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            >
              <UserIcon className="size-3" /> {p.name}
            </button>
          ))}
        </div>

        {l.stage === "lost" && (
          <select
            aria-label="Why was it lost?"
            value={l.lost_reason}
            onChange={(e) => save({ lost_reason: e.target.value as LostReason })}
            className={cn(
              controlCls,
              "mt-2 h-7",
              !l.lost_reason && "border-amber-500/60 text-amber-700 dark:text-amber-400",
            )}
          >
            <option value="" disabled>
              Why was it lost?
            </option>
            {LOST_REASONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        )}

        {/* Pinned: what's owed stays in view while the thread scrolls. */}
        {l.steps.length > 0 ? (
          <div className="mt-3 space-y-1.5 rounded-md border-l-2 border-amber-500 bg-muted/40 py-2 pl-2.5 pr-2">
            {l.steps.map((s) => (
              <StepRow key={s.key} step={s} label="Next" />
            ))}
          </div>
        ) : (
          l.stage !== "won" &&
          l.stage !== "lost" && (
            <p className="mt-3 text-[12px] text-amber-700 dark:text-amber-400">
              No next step — add what they need next to your next update.
            </p>
          )
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {(l.stage === "won" || l.stage === "offer") && (
          <LicencesBlock
            filters={{ lead: l.key }}
            defaults={{ title: l.title, company: l.company, project: l.project?.id ?? null, lead: l.key }}
          />
        )}
        <LeadPayments lead={l} />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== l.notes && save({ notes })}
          rows={Math.min(6, Math.max(2, notes.split("\n").length))}
          placeholder="Add context — scope, who decides, pricing…"
          className="block w-full resize-none border-b border-border/60 bg-transparent px-4 py-3 text-[13px] leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/60 focus:bg-accent/20"
          dir="auto"
        />
        <UpdateFeed
          updates={l.updates}
          chronological
          onOpenContact={onOpenContact}
          empty="No updates yet — post the first call, message or meeting below."
        />
      </div>

      <div className="shrink-0 border-t border-border p-3 pb-safe">
        <UpdateComposer
          key={l.key}
          lead={l.key}
          company={l.company}
          suggested={l.people}
          canFile={!!l.project}
          placeholder={`What happened on ${l.title}?`}
        />
      </div>
    </div>
  );
}

/** The money side of a lead: its payments and how much of it is in. Shown
 *  once there is an offer, a win, or any payment already linked. */
function LeadPayments({ lead: l }: { lead: Detail }) {
  const payments = usePayments({ lead: l.key });
  const [draft, setDraft] = useState<PaymentDraft | null>(null);
  const rows = payments.data ?? [];
  if (!rows.length && l.stage !== "won" && l.stage !== "offer") return null;
  const total = rows.reduce((n, p) => n + p.amount, 0);
  const paid = rows.filter((p) => p.status === "paid").reduce((n, p) => n + p.amount, 0);

  return (
    <section className="border-b border-border/60 pb-2">
      <SectionHeader
        title="Payments"
        count={rows.length || undefined}
        action={
          <button
            type="button"
            className={ghostBtnCls}
            onClick={() =>
              setDraft({
                title: l.title,
                company: l.company,
                project: l.project?.id ?? null,
                lead: l.key,
              })
            }
          >
            + Payment
          </button>
        }
      />
      {rows.length > 0 && (
        <div className="px-4">
          <p className="pb-1 text-[12px] tabular-nums text-muted-foreground">
            {money(paid)} of {money(total)} paid
          </p>
          {rows.map((p) => (
            <PaymentRow key={p.id} p={p} compact onEdit={(payment) => setDraft({ payment })} />
          ))}
        </div>
      )}
      <PaymentDialog draft={draft} onClose={() => setDraft(null)} />
    </section>
  );
}
