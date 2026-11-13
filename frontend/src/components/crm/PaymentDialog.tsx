"use client";

/** Add or edit a payment. Pick the licence it pays for and the product,
 *  company, project and lead come from the licence (the server copies them);
 *  a payment with no licence — a setup fee, a one-off build — takes them
 *  directly. Status is derived server-side from the due and paid dates. */

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
import {
  type Payment,
  type PaymentType,
  useContacts,
  useCreateContact,
  useDeletePayment,
  useLeads,
  useLicences,
  useSavePayment,
} from "@/hooks/use-crm";
import { useProjectsQuery } from "@/hooks/use-projects";
import { PAYMENT_TYPES, errorMessage, isoDay, shortDay } from "@/lib/crm-meta";

import { Field, inputCls } from "./shared";

export type PaymentDraft = {
  /** Editing an existing payment. */
  payment?: Payment;
  /** New payment defaults — e.g. from a lead's pane or the Billing filters. */
  title?: string;
  company?: { id: number; name: string } | null;
  project?: number | null;
  lead?: string | null;
  licence?: number | null;
};

export function PaymentDialog({
  draft,
  onClose,
}: {
  draft: PaymentDraft | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={draft != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {draft && <Body draft={draft} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ draft, onClose }: { draft: PaymentDraft; onClose: () => void }) {
  const p = draft.payment;
  const companies = useContacts({ kind: "company", all: "1" });
  const projects = useProjectsQuery({ includeArchived: false });
  const licences = useLicences({});
  const createCompany = useCreateContact();
  const save = useSavePayment();
  const remove = useDeletePayment();

  const [licence, setLicence] = useState(String(p?.licence?.id ?? draft.licence ?? ""));
  const [title, setTitle] = useState(p?.title ?? draft.title ?? "");
  const [company, setCompany] = useState(p?.company.name ?? draft.company?.name ?? "");
  const [project, setProject] = useState(String(p?.project?.id ?? draft.project ?? ""));
  const [lead, setLead] = useState(p?.lead?.key ?? draft.lead ?? "");
  const [type, setType] = useState<PaymentType>(p?.type ?? (draft.licence ? "licence" : "instalment"));
  const [amount, setAmount] = useState(p ? String(p.amount) : "");
  const [dueOn, setDueOn] = useState(p?.due_on ?? isoDay(0));
  const [paidOn, setPaidOn] = useState(p?.paid_on ?? "");

  // Licences of the filtered company first, if one is set; otherwise all.
  const options = (licences.data ?? []).filter(
    (l) => !draft.company || l.company.id === draft.company.id || String(l.id) === licence,
  );
  const picked = (licences.data ?? []).find((l) => String(l.id) === licence);
  const prefix = projects.data?.results.find((x) => String(x.id) === project)?.prefix ?? "";
  const leads = useLeads(prefix, !picked);
  const companyLeads = (leads.data ?? []).filter(
    (l) => !company.trim() || l.company?.name.toLowerCase() === company.trim().toLowerCase(),
  );
  const pending = save.isPending || createCompany.isPending;
  const valid = Number(amount) > 0 && dueOn && (picked || (title.trim() && company.trim()));

  const submit = async () => {
    if (!valid) return;
    try {
      const money = { type, amount: Number(amount), due_on: dueOn, paid_on: paidOn || null };
      if (picked) {
        await save.mutateAsync({ id: p?.id, licence: picked.id, ...money });
      } else {
        const name = company.trim();
        const known = companies.data?.find((c) => c.name.toLowerCase() === name.toLowerCase());
        // Same find-or-create as a new lead: an unknown name becomes a company.
        const companyId = known?.id ?? (await createCompany.mutateAsync({ kind: "company", name })).id;
        await save.mutateAsync({
          id: p?.id,
          licence: null,
          title: title.trim(),
          company: companyId,
          project: project ? Number(project) : null,
          lead: lead || null,
          ...money,
        });
      }
      toast.success(p ? "Payment saved" : "Payment added");
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
        <DialogTitle className="text-[14px]">{p ? "Edit payment" : "New payment"}</DialogTitle>
      </DialogHeader>
      <div className="mt-3 space-y-2.5">
        <Field label="Pays for licence">
          <select value={licence} onChange={(e) => setLicence(e.target.value)} className={inputCls}>
            <option value="">— None (setup fee, one-off…)</option>
            {options.map((l) => (
              <option key={l.id} value={l.id}>
                {l.company.name} · {l.title} · {shortDay(l.starts_on)} – {shortDay(l.ends_on)}
              </option>
            ))}
          </select>
        </Field>

        {!picked && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Company">
                <input
                  list="crm-payment-companies"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Who owes it"
                  className={inputCls}
                />
                <datalist id="crm-payment-companies">
                  {(companies.data ?? []).map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
              </Field>
              <Field label="For">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Mowafeq Workspace"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Project">
                <select value={project} onChange={(e) => setProject(e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {(projects.data?.results ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Lead (optional)">
                <select value={lead} onChange={(e) => setLead(e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {lead && !companyLeads.some((l) => l.key === lead) && <option value={lead}>{lead}</option>}
                  {companyLeads.map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.key} · {l.title}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as PaymentType)} className={inputCls}>
              {PAYMENT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount (QAR)">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10000"
              className={inputCls}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Due">
            <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Paid (blank = not yet)">
            <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={inputCls} />
          </Field>
        </div>
      </div>
      <DialogFooter className="mt-4">
        {p && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto text-destructive"
            onClick={() => {
              if (!window.confirm("Delete this payment?")) return;
              remove.mutate(p.id, { onSuccess: onClose, onError: (e) => toast.error(errorMessage(e)) });
            }}
          >
            Delete
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || !valid}>
          {pending ? "Saving…" : p ? "Save" : "Add payment"}
        </Button>
      </DialogFooter>
    </form>
  );
}
