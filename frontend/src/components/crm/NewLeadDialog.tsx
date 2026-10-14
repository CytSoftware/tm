"use client";

/** Open a lead: title, company (an existing one, or typed and created), the
 *  project it's for, and stage. */

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
  type LeadStage,
  useContacts,
  useCreateContact,
  useCreateLead,
} from "@/hooks/use-crm";
import { useProjectsQuery } from "@/hooks/use-projects";
import { STAGES, errorMessage } from "@/lib/crm-meta";

import { Field, inputCls } from "./shared";

export type NewLeadDefaults = {
  stage?: LeadStage;
  company?: { id: number; name: string } | null;
  /** Project id — the CRM's current scope. */
  project?: number;
};

export function NewLeadDialog({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: NewLeadDefaults | null;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  return (
    <Dialog open={defaults != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {defaults && <Body defaults={defaults} onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: NewLeadDefaults;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const companies = useContacts({ kind: "company", all: "1" });
  const projects = useProjectsQuery({ includeArchived: false });
  const createCompany = useCreateContact();
  const create = useCreateLead();

  const [title, setTitle] = useState("");
  const [company, setCompany] = useState(defaults.company?.name ?? "");
  const [project, setProject] = useState(defaults.project ? String(defaults.project) : "");
  const [stage, setStage] = useState<LeadStage>(defaults.stage ?? "new");
  const pending = create.isPending || createCompany.isPending;

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const name = company.trim();
      let companyId: number | null = null;
      if (name) {
        const known = companies.data?.find((c) => c.name.toLowerCase() === name.toLowerCase());
        // Unknown names are found-or-created server-side, same as meeting ingest.
        companyId = known?.id ?? (await createCompany.mutateAsync({ kind: "company", name })).id;
      }
      const lead = await create.mutateAsync({
        title: title.trim(),
        company: companyId,
        project: project ? Number(project) : null,
        stage,
      });
      toast.success(`${lead.key} created`);
      onClose();
      onCreated(lead.key);
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
        <DialogTitle className="text-[14px]">New lead</DialogTitle>
      </DialogHeader>
      <div className="mt-3 space-y-2.5">
        <Field label="Title">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Mowafeq pilot"
            className={inputCls}
          />
        </Field>
        <Field label="Company">
          <input
            list="crm-companies"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="ECG — created if new"
            className={inputCls}
          />
          <datalist id="crm-companies">
            {(companies.data ?? []).map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Project">
            <select value={project} onChange={(e) => setProject(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {(projects.data?.results ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stage">
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value as LeadStage)}
              className={inputCls}
            >
              {STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
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
        <Button type="submit" size="sm" disabled={pending || !title.trim()}>
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </DialogFooter>
    </form>
  );
}
