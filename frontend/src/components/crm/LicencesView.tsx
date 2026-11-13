"use client";

/**
 * Licences — who is entitled to what, until when. Separate from Billing
 * (the money): a licence's period rarely lines up with its payments.
 *
 * Status comes from the server, derived from the period. The tab shows what
 * needs attention: expiring without a renewal, active, and lapsed (ended and
 * nobody renewed it). Ended-but-renewed licences are history; they show on
 * the company and lead panes, not here.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Trash2 } from "lucide-react";

import {
  type Licence,
  type Payment,
  type PaymentType,
  type PlannedPayment,
  useContacts,
  useCreateContact,
  useDeleteLicence,
  useLeads,
  useLicences,
  usePayments,
  useSaveLicence,
  useSavePayment,
} from "@/hooks/use-crm";
import { useProjectsQuery } from "@/hooks/use-projects";
import {
  PAYMENT_TYPES,
  companyDomain,
  errorMessage,
  isoDay,
  licenceState,
  money,
  shortDay,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { PaymentRow } from "./BillingView";
import { PaymentDialog, type PaymentDraft } from "./PaymentDialog";
import { ContactAvatar, Field, SectionHeader, ghostBtnCls, inputCls } from "./shared";

export function LicencesView({
  licences,
  onEdit,
  onOpenLead,
}: {
  licences: Licence[];
  onEdit: (l: Licence) => void;
  onOpenLead: (key: string) => void;
}) {
  const expiring = licences.filter((l) => l.status === "expiring" && !l.renewed);
  const active = licences.filter(
    (l) => l.status === "active" || l.status === "upcoming" || (l.status === "expiring" && l.renewed),
  );
  const lapsed = licences.filter((l) => l.status === "ended" && !l.renewed);
  const row = (l: Licence) => <LicenceRow key={l.id} l={l} onEdit={onEdit} onOpenLead={onOpenLead} />;

  return (
    <div className="h-full min-h-0 overflow-y-auto pb-10">
      <div className="mx-auto max-w-4xl">
        <div className="grid grid-cols-3 gap-2 px-4 pt-4 max-sm:grid-cols-1">
          <Stat label="Active" count={active.length} />
          <Stat label="Expiring in 60 days" count={expiring.length} tone={expiring.length ? "warn" : undefined} />
          <Stat label="Lapsed" count={lapsed.length} tone={lapsed.length ? "danger" : undefined} />
        </div>
        {licences.length === 0 && (
          <p className="px-4 pt-10 text-center text-[13px] text-muted-foreground">
            No licences yet. Add one with “Licence”, or from a won lead.
          </p>
        )}
        {expiring.length > 0 && (
          <>
            <SectionHeader title="Expiring — not renewed" count={expiring.length} />
            {expiring.map(row)}
          </>
        )}
        {active.length > 0 && (
          <>
            <SectionHeader title="Active" count={active.length} />
            {active.map(row)}
          </>
        )}
        {lapsed.length > 0 && (
          <>
            <SectionHeader title="Lapsed" count={lapsed.length} tone="danger" />
            {lapsed.map(row)}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, count, tone }: { label: string; count: number; tone?: "warn" | "danger" }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-[16px] font-semibold tabular-nums",
          tone === "warn" && "text-amber-700 dark:text-amber-400",
          tone === "danger" && "text-destructive",
        )}
      >
        {count}
      </div>
    </div>
  );
}

/** One licence. Clicking it edits it. `compact` drops the company (for the
 *  company and lead panes, where it's implied). */
export function LicenceRow({
  l,
  onEdit,
  onOpenLead,
  compact,
}: {
  l: Licence;
  onEdit: (l: Licence) => void;
  onOpenLead?: (key: string) => void;
  compact?: boolean;
}) {
  const state = licenceState(l);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(l)}
      onKeyDown={(e) => e.key === "Enter" && onEdit(l)}
      className={cn(
        "flex min-w-0 items-center gap-2.5 border-b border-border/60 py-2 text-[13px] hover:bg-accent/40",
        compact ? "px-0" : "px-4",
      )}
    >
      {!compact && (
        <ContactAvatar name={l.company.name} kind="company" domain={companyDomain(l.company.website)} size="sm" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate">
          {!compact && <span className="font-medium">{l.company.name}</span>}
          {!compact && <span className="text-muted-foreground"> · </span>}
          <span className={cn(compact && "font-medium")}>{l.title}</span>
        </div>
        <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <span>
            {shortDay(l.starts_on)} – {shortDay(l.ends_on)}
          </span>
          {l.lead && onOpenLead && !compact && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLead(l.lead!.key);
              }}
              className="font-mono hover:text-foreground hover:underline"
            >
              · {l.lead.key}
            </button>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn("text-[12px]", state.cls)}>{state.label}</div>
        <div className="text-[11px] tabular-nums text-muted-foreground">
          {l.total ? `${money(l.paid)} of ${money(l.total)} paid` : "No payments linked"}
        </div>
      </div>
    </div>
  );
}

/** A company's or lead's licences, newest period first, with "+ Licence". */
export function LicencesBlock({
  filters,
  defaults,
}: {
  filters: { company?: string; lead?: string };
  defaults: LicenceDraft;
}) {
  const licences = useLicences(filters);
  const [draft, setDraft] = useState<LicenceDraft | null>(null);
  const rows = [...(licences.data ?? [])].sort((a, b) => b.starts_on.localeCompare(a.starts_on));
  return (
    <section className="border-b border-border/60 pb-2">
      <SectionHeader
        title="Licences"
        count={rows.length || undefined}
        action={
          <button type="button" className={ghostBtnCls} onClick={() => setDraft(defaults)}>
            + Licence
          </button>
        }
      />
      {rows.length > 0 && (
        <div className="px-4">
          {rows.map((l) => (
            <LicenceRow key={l.id} l={l} compact onEdit={(licence) => setDraft({ licenceId: licence.id })} />
          ))}
        </div>
      )}
      <LicenceDialog draft={draft} onClose={() => setDraft(null)} />
    </section>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────────

/** What the licence dialog opens on: an existing licence (`licenceId`), a
 *  renewal of one (`renewOf`), or a new licence with optional defaults. */
export type LicenceDraft = {
  licenceId?: number;
  renewOf?: number;
  title?: string;
  company?: { id: number; name: string } | null;
  project?: number | null;
  lead?: string | null;
};

export function LicenceDialog({ draft, onClose }: { draft: LicenceDraft | null; onClose: () => void }) {
  const [view, setView] = useState<LicenceDraft | null>(null);
  // The dialog can switch itself from a licence to its renewal.
  const current = view ?? draft;
  const close = () => {
    setView(null);
    onClose();
  };
  return (
    <Dialog open={draft != null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-2xl">
        {current && (
          <LicenceBody
            key={`${current.licenceId ?? ""}-${current.renewOf ?? ""}`}
            draft={current}
            onClose={close}
            onRenew={(id) => setView({ renewOf: id })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LicenceBody({
  draft,
  onClose,
  onRenew,
}: {
  draft: LicenceDraft;
  onClose: () => void;
  onRenew: (id: number) => void;
}) {
  // Fresh rows from the cache, so totals and statuses follow every payment edit.
  const all = useLicences({});
  const id = draft.licenceId ?? draft.renewOf;
  const source = id != null ? all.data?.find((l) => l.id === id) : undefined;
  const sourcePayments = usePayments({ licence: id != null ? String(id) : undefined }, id != null);
  if (id != null && (!source || sourcePayments.isLoading))
    return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (draft.licenceId != null && source)
    return <EditLicence licence={source} payments={sourcePayments.data ?? []} onClose={onClose} onRenew={onRenew} />;
  return <NewLicence draft={draft} renewOf={source} renewPayments={sourcePayments.data ?? []} onClose={onClose} />;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (day: string, { years = 0, days = 0 }) => {
  const d = new Date(`${day}T00:00:00`);
  d.setFullYear(d.getFullYear() + years);
  d.setDate(d.getDate() + days);
  return ymd(d);
};
/** One year from `start`, minus a day: 2026-11-07 → 2027-11-06. */
const yearAfter = (start: string) => shift(start, { years: 1, days: -1 });

// ── Shared fields ───────────────────────────────────────────────────────────

type Header = {
  title: string;
  company: string;
  project: string;
  startsOn: string;
  endsOn: string;
  lead: string;
};

function HeaderFields({
  h,
  set,
  autoEnd,
}: {
  h: Header;
  set: (patch: Partial<Header>) => void;
  /** New licences: moving the start moves the end to a year later. */
  autoEnd: boolean;
}) {
  const companies = useContacts({ kind: "company", all: "1" });
  const projects = useProjectsQuery({ includeArchived: false });
  const prefix = projects.data?.results.find((x) => String(x.id) === h.project)?.prefix ?? "";
  const leads = useLeads(prefix);
  const companyLeads = (leads.data ?? []).filter(
    (x) => !h.company.trim() || x.company?.name.toLowerCase() === h.company.trim().toLowerCase(),
  );
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Company">
          <input
            list="crm-licence-companies"
            value={h.company}
            onChange={(e) => set({ company: e.target.value })}
            placeholder="Who holds it"
            className={inputCls}
          />
          <datalist id="crm-licence-companies">
            {(companies.data ?? []).map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Product">
          <input
            value={h.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Mowafeq Workspace"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Starts">
          <input
            type="date"
            value={h.startsOn}
            onChange={(e) =>
              set({ startsOn: e.target.value, ...(autoEnd && e.target.value ? { endsOn: yearAfter(e.target.value) } : {}) })
            }
            className={inputCls}
          />
        </Field>
        <Field label="Ends">
          <input type="date" value={h.endsOn} onChange={(e) => set({ endsOn: e.target.value })} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Project">
          <select value={h.project} onChange={(e) => set({ project: e.target.value })} className={inputCls}>
            <option value="">—</option>
            {(projects.data?.results ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lead (optional)">
          <select value={h.lead} onChange={(e) => set({ lead: e.target.value })} className={inputCls}>
            <option value="">—</option>
            {h.lead && !companyLeads.some((x) => x.key === h.lead) && <option value={h.lead}>{h.lead}</option>}
            {companyLeads.map((x) => (
              <option key={x.key} value={x.key}>
                {x.key} · {x.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

/** Company name → id, creating the company if it's new (same as a new lead). */
function useCompanyId() {
  const companies = useContacts({ kind: "company", all: "1" });
  const create = useCreateContact();
  return async (name: string) => {
    const known = companies.data?.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    return known?.id ?? (await create.mutateAsync({ kind: "company", name: name.trim() })).id;
  };
}

const headerValid = (h: Header) =>
  !!(h.title.trim() && h.company.trim() && h.startsOn && h.endsOn && h.endsOn >= h.startsOn);

// ── Edit: the licence and its payment schedule ──────────────────────────────

function EditLicence({
  licence: l,
  payments,
  onClose,
  onRenew,
}: {
  licence: Licence;
  payments: Payment[];
  onClose: () => void;
  onRenew: (id: number) => void;
}) {
  const save = useSaveLicence();
  const remove = useDeleteLicence();
  const companyId = useCompanyId();
  const [h, setH] = useState<Header>({
    title: l.title,
    company: l.company.name,
    project: String(l.project?.id ?? ""),
    startsOn: l.starts_on,
    endsOn: l.ends_on,
    lead: l.lead?.key ?? "",
  });
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft | null>(null);
  const state = licenceState(l);
  const dirty =
    h.title !== l.title ||
    h.company !== l.company.name ||
    h.project !== String(l.project?.id ?? "") ||
    h.startsOn !== l.starts_on ||
    h.endsOn !== l.ends_on ||
    h.lead !== (l.lead?.key ?? "");

  const submit = async () => {
    if (!headerValid(h)) return;
    try {
      await save.mutateAsync({
        id: l.id,
        title: h.title.trim(),
        company: await companyId(h.company),
        project: h.project ? Number(h.project) : null,
        starts_on: h.startsOn,
        ends_on: h.endsOn,
        lead: h.lead || null,
      });
      toast.success("Licence saved");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-baseline gap-2 text-[14px]">
          {l.company.name} · {l.title}
          <span className={cn("text-[12px] font-normal", state.cls)}>{state.label}</span>
        </DialogTitle>
      </DialogHeader>
      <div className="mt-3">
        <HeaderFields h={h} set={(patch) => setH((x) => ({ ...x, ...patch }))} autoEnd={false} />
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Payments</h3>
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {money(l.paid)} of {money(l.total)} paid
          </span>
        </div>
        <div className="mt-1 max-h-56 overflow-y-auto">
          {payments.map((p) => (
            <PaymentRow key={p.id} p={p} compact onEdit={(payment) => setPaymentDraft({ payment })} />
          ))}
        </div>
        <QuickPayment licenceId={l.id} />
      </div>

      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto text-destructive"
          onClick={() => {
            if (!window.confirm("Delete this licence? Its payments stay, unlinked.")) return;
            remove.mutate(l.id, { onSuccess: onClose, onError: (e) => toast.error(errorMessage(e)) });
          }}
        >
          Delete
        </Button>
        {!l.renewed && (
          <Button type="button" variant="outline" size="sm" onClick={() => onRenew(l.id)}>
            Renew…
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending || !dirty || !headerValid(h)}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
      <PaymentDialog draft={paymentDraft} onClose={() => setPaymentDraft(null)} />
    </form>
  );
}

/** One-line "+ payment" under a licence: type, amount, due — the rest is the licence's. */
function QuickPayment({ licenceId }: { licenceId: number }) {
  const save = useSavePayment();
  const [type, setType] = useState<PaymentType>("instalment");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(isoDay(0));
  const add = () =>
    save.mutate(
      { licence: licenceId, type, amount: Number(amount), due_on: due },
      {
        onSuccess: () => {
          setAmount("");
          toast.success("Payment added");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <select value={type} onChange={(e) => setType(e.target.value as PaymentType)} className={cn(inputCls, "w-36")}>
        {PAYMENT_TYPES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min="0"
        step="any"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="QAR"
        className={cn(inputCls, "w-28")}
      />
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={cn(inputCls, "w-36")} />
      <button
        type="button"
        className={ghostBtnCls}
        disabled={save.isPending || !(Number(amount) > 0) || !due}
        onClick={add}
      >
        + Payment
      </button>
    </div>
  );
}

// ── New licence (or renewal) with its payment plan ──────────────────────────

type PlanRow = { type: PaymentType; amount: string; due_on: string; paid_on: string };

function NewLicence({
  draft,
  renewOf,
  renewPayments,
  onClose,
}: {
  draft: LicenceDraft;
  renewOf?: Licence;
  renewPayments: Payment[];
  onClose: () => void;
}) {
  const save = useSaveLicence();
  const companyId = useCompanyId();
  const start = renewOf ? shift(renewOf.ends_on, { days: 1 }) : isoDay(0);
  const [h, setH] = useState<Header>({
    title: renewOf?.title ?? draft.title ?? "",
    company: renewOf?.company.name ?? draft.company?.name ?? "",
    project: String(renewOf?.project?.id ?? draft.project ?? ""),
    startsOn: start,
    endsOn: yearAfter(start),
    lead: renewOf?.lead?.key ?? draft.lead ?? "",
  });
  // A renewal starts from last period's plan, a year later and unpaid — edit
  // the amounts if the price changed.
  const [plan, setPlan] = useState<PlanRow[]>(
    renewOf
      ? renewPayments.map((p) => ({
          type: p.type,
          amount: String(p.amount),
          due_on: shift(p.due_on, { years: 1 }),
          paid_on: "",
        }))
      : [{ type: "licence", amount: "", due_on: start, paid_on: "" }],
  );
  const setRow = (i: number, patch: Partial<PlanRow>) =>
    setPlan((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const rows = plan.filter((r) => Number(r.amount) > 0 && r.due_on);
  const total = rows.reduce((n, r) => n + Number(r.amount), 0);

  const submit = async () => {
    if (!headerValid(h)) return;
    try {
      await save.mutateAsync({
        title: h.title.trim(),
        company: await companyId(h.company),
        project: h.project ? Number(h.project) : null,
        starts_on: h.startsOn,
        ends_on: h.endsOn,
        lead: h.lead || null,
        payments: rows.map(
          (r): PlannedPayment => ({ type: r.type, amount: Number(r.amount), due_on: r.due_on, paid_on: r.paid_on || null }),
        ),
      });
      toast.success(renewOf ? `Renewed until ${shortDay(h.endsOn)}` : "Licence added");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-[14px]">
          {renewOf ? `Renew ${renewOf.company.name} · ${renewOf.title}` : "New licence"}
        </DialogTitle>
      </DialogHeader>
      <div className="mt-3">
        <HeaderFields h={h} set={(patch) => setH((x) => ({ ...x, ...patch }))} autoEnd />
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Payment plan</h3>
          <span className="text-[12px] tabular-nums text-muted-foreground">{money(total)}</span>
        </div>
        <div className="mt-1 space-y-1.5">
          {plan.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <select
                value={r.type}
                onChange={(e) => setRow(i, { type: e.target.value as PaymentType })}
                className={cn(inputCls, "w-32")}
              >
                {PAYMENT_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                step="any"
                value={r.amount}
                onChange={(e) => setRow(i, { amount: e.target.value })}
                placeholder="QAR"
                className={cn(inputCls, "w-24")}
              />
              <input
                type="date"
                value={r.due_on}
                onChange={(e) => setRow(i, { due_on: e.target.value })}
                title="Due"
                className={cn(inputCls, "w-36")}
              />
              <input
                type="date"
                value={r.paid_on}
                onChange={(e) => setRow(i, { paid_on: e.target.value })}
                title="Paid (blank = not yet)"
                className={cn(inputCls, "w-36", !r.paid_on && "text-muted-foreground")}
              />
              <button
                type="button"
                aria-label="Remove row"
                onClick={() => setPlan((rs) => rs.filter((_, j) => j !== i))}
                className="tap-target grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={cn(ghostBtnCls, "mt-1.5 px-0")}
          onClick={() =>
            setPlan((rs) => [...rs, { type: "instalment", amount: "", due_on: rs.at(-1)?.due_on ?? h.startsOn, paid_on: "" }])
          }
        >
          + Row
        </button>
        <p className="mt-1 text-[11px] text-muted-foreground">Due · paid (blank = not yet). Empty rows are skipped.</p>
      </div>

      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending || !headerValid(h)}>
          {save.isPending ? "Saving…" : renewOf ? "Renew" : "Add licence"}
        </Button>
      </DialogFooter>
    </form>
  );
}
