"use client";

/**
 * Billing — what customers owe us. Every row is a payment; its status
 * (paid / overdue / upcoming) comes from the server, derived from the dates.
 *
 * Sections: Overdue · Upcoming · Paid this year. Renewals live on the
 * Licences tab. The strip on
 * top totals what's late, what's due in the next 30 days and what came in.
 */

import { Check } from "lucide-react";
import { toast } from "sonner";

import { type Payment, useSavePayment } from "@/hooks/use-crm";
import {
  PAYMENT_STATUS,
  companyDomain,
  daysUntil,
  errorMessage,
  isoDay,
  money,
  paymentTypeLabel,
  shortDay,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { ContactAvatar, SectionHeader } from "./shared";

const sum = (rows: Payment[]) => rows.reduce((n, p) => n + p.amount, 0);

export function BillingView({
  payments,
  onEdit,
  onOpenLead,
  onOpenLicence,
}: {
  payments: Payment[];
  onEdit: (p: Payment) => void;
  onOpenLead: (key: string) => void;
  onOpenLicence: (id: number) => void;
}) {
  const year = String(new Date().getFullYear());
  const overdue = payments.filter((p) => p.status === "overdue");
  const upcoming = payments.filter((p) => p.status === "upcoming");
  const paid = payments
    .filter((p) => p.status === "paid" && p.paid_on!.startsWith(year))
    .sort((a, b) => b.paid_on!.localeCompare(a.paid_on!));
  const next30 = upcoming.filter((p) => daysUntil(p.due_on) <= 30);

  const row = (p: Payment) => (
    <PaymentRow key={p.id} p={p} onEdit={onEdit} onOpenLead={onOpenLead} onOpenLicence={onOpenLicence} />
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto pb-10">
      <div className="mx-auto max-w-4xl">
        <div className="grid grid-cols-3 gap-2 px-4 pt-4 max-sm:grid-cols-1">
          <Stat label="Overdue" value={sum(overdue)} count={overdue.length} tone={overdue.length ? "danger" : undefined} />
          <Stat label="Due in the next 30 days" value={sum(next30)} count={next30.length} />
          <Stat label={`Collected in ${year}`} value={sum(paid)} count={paid.length} tone="good" />
        </div>

        {payments.length === 0 && (
          <p className="px-4 pt-10 text-center text-[13px] text-muted-foreground">
            No payments yet. Add one with “Payment”, or from a won lead.
          </p>
        )}
        {overdue.length > 0 && (
          <>
            <SectionHeader title="Overdue" count={overdue.length} tone="danger" />
            {overdue.map(row)}
          </>
        )}
        {upcoming.length > 0 && (
          <>
            <SectionHeader title="Upcoming" count={upcoming.length} />
            {upcoming.map(row)}
          </>
        )}
        {paid.length > 0 && (
          <>
            <SectionHeader title={`Paid in ${year}`} count={paid.length} />
            {paid.map(row)}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  count,
  tone,
}: {
  label: string;
  value: number;
  count: number;
  tone?: "danger" | "good";
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-[16px] font-semibold tabular-nums",
          tone === "danger" && "text-destructive",
          tone === "good" && "text-emerald-700 dark:text-emerald-400",
        )}
      >
        {money(value)}
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground/70">
        {count} payment{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}

/** One payment. Clicking the row edits it; "Mark paid" stamps today. Shared
 *  by the Billing tab and the lead pane (`compact` drops the company). */
export function PaymentRow({
  p,
  onEdit,
  onOpenLead,
  onOpenLicence,
  compact,
}: {
  p: Payment;
  onEdit: (p: Payment) => void;
  onOpenLead?: (key: string) => void;
  onOpenLicence?: (id: number) => void;
  compact?: boolean;
}) {
  const save = useSavePayment();
  const days = daysUntil(p.due_on);
  const when =
    p.status === "paid"
      ? `Paid ${shortDay(p.paid_on)}`
      : p.status === "overdue"
        ? `${-days}d overdue`
        : days === 0
          ? "Due today"
          : days < 45
            ? `In ${days}d`
            : `Due ${shortDay(p.due_on)}`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(p)}
      onKeyDown={(e) => e.key === "Enter" && onEdit(p)}
      className={cn(
        "group flex min-w-0 items-center gap-2.5 border-b border-border/60 py-2 text-[13px] hover:bg-accent/40",
        compact ? "px-0" : "px-4",
      )}
    >
      {!compact && (
        <ContactAvatar
          name={p.company.name}
          kind="company"
          domain={companyDomain(p.company.website)}
          size="sm"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate">
          {!compact && <span className="font-medium">{p.company.name}</span>}
          {!compact && <span className="text-muted-foreground"> · </span>}
          <span className={cn(compact && "font-medium")}>{p.title}</span>
        </div>
        <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <span>{paymentTypeLabel(p.type)}</span>
          <span>· due {shortDay(p.due_on)}</span>
          {p.licence && onOpenLicence && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLicence(p.licence!.id);
              }}
              className="hover:text-foreground hover:underline"
            >
              · for licence {p.licence.starts_on.slice(0, 4)}–{p.licence.ends_on.slice(2, 4)}
            </button>
          )}
          {p.lead && onOpenLead && !compact && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLead(p.lead!.key);
              }}
              className="font-mono hover:text-foreground hover:underline"
            >
              · {p.lead.key}
            </button>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-medium tabular-nums">{money(p.amount)}</div>
        <div className={cn("text-[11px]", PAYMENT_STATUS[p.status].cls)}>{when}</div>
      </div>
      {p.status !== "paid" ? (
        <button
          type="button"
          title="Mark paid today"
          aria-label="Mark paid today"
          onClick={(e) => {
            e.stopPropagation();
            save.mutate(
              { id: p.id, paid_on: isoDay(0) },
              {
                onSuccess: () => toast.success(`${money(p.amount)} marked paid`),
                onError: (err) => toast.error(errorMessage(err)),
              },
            );
          }}
          className="tap-target grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:border-emerald-500/50 hover:text-emerald-700"
        >
          <Check className="size-3.5" />
        </button>
      ) : (
        <span className="size-7 shrink-0" />
      )}
    </div>
  );
}
