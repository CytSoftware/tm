"use client";

/**
 * Create or edit a contact's CRM fields.
 *
 * Creating finds-or-creates by name on the server (same resolution as meeting
 * ingest), so typing the name of someone a recording already knows promotes
 * that person instead of making a duplicate.
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
import {
  type ContactDetail,
  type ContactWrite,
  type EntityKind,
  type Relationship,
  useCreateContact,
  useUpdateContact,
} from "@/hooks/use-crm";
import { useUsersQuery } from "@/hooks/use-users";
import {
  RELATIONSHIP_META,
  RELATIONSHIP_ORDER,
  errorMessage,
  userLabel,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { inputCls } from "./shared";

type Form = {
  kind: EntityKind;
  name: string;
  relationship: Relationship | "";
  owner: string;
  headline: string;
  company: string;
  emails: string;
  phone: string;
  whatsapp: string;
  linkedin_url: string;
  website: string;
  wiki_slug: string;
};

function initial(contact?: ContactDetail, kind: EntityKind = "person"): Form {
  return {
    kind: contact?.kind ?? kind,
    name: contact?.name ?? "",
    relationship: contact?.relationship ?? "lead",
    owner: contact?.owner ? String(contact.owner.id) : "",
    headline: contact?.headline ?? "",
    company: contact?.company?.name ?? "",
    emails: contact?.emails.join(", ") ?? "",
    phone: contact?.phone ?? "",
    whatsapp: contact?.whatsapp ?? "",
    linkedin_url: contact?.linkedin_url ?? "",
    website: contact?.website ?? "",
    wiki_slug: contact?.wiki_slug ?? "",
  };
}

export function ContactEditDialog({
  open,
  onOpenChange,
  contact,
  defaultKind,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent = create. */
  contact?: ContactDetail;
  defaultKind?: EntityKind;
  onCreated?: (id: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && (
          <Body
            // Remount per open so the form starts from the current contact.
            key={contact?.id ?? "new"}
            contact={contact}
            defaultKind={defaultKind}
            onClose={() => onOpenChange(false)}
            onCreated={onCreated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  contact,
  defaultKind,
  onClose,
  onCreated,
}: {
  contact?: ContactDetail;
  defaultKind?: EntityKind;
  onClose: () => void;
  onCreated?: (id: number) => void;
}) {
  const [form, setForm] = useState<Form>(() => initial(contact, defaultKind));
  const create = useCreateContact();
  const update = useUpdateContact();
  const users = useUsersQuery();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const saving = create.isPending || update.isPending;

  const submit = () => {
    const body: ContactWrite = {
      name: form.name.trim(),
      relationship: form.relationship,
      owner: form.owner ? Number(form.owner) : null,
      headline: form.headline.trim(),
      emails: form.emails
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter(Boolean),
      phone: form.phone.trim(),
      whatsapp: form.whatsapp.trim(),
      linkedin_url: form.linkedin_url.trim(),
      website: form.website.trim(),
      wiki_slug: form.wiki_slug.trim(),
    };
    if (form.kind === "person") body.company = form.company.trim() || null;
    const opts = {
      onError: (e: unknown) => toast.error(errorMessage(e)),
    };
    if (contact) {
      update.mutate({ id: contact.id, ...body }, { ...opts, onSuccess: () => onClose() });
    } else {
      create.mutate(
        { kind: form.kind, ...body },
        {
          ...opts,
          onSuccess: (c) => {
            toast.success(`${c.name} is in the CRM`);
            onClose();
            onCreated?.(c.id);
          },
        },
      );
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (form.name.trim()) submit();
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-[14px]">
          {contact ? `Edit ${contact.name}` : "New contact"}
        </DialogTitle>
      </DialogHeader>

      <div className="mt-3 space-y-2.5">
        {!contact && (
          <div className="flex rounded-md border border-border p-0.5">
            {(["person", "company"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={form.kind === k}
                onClick={() => set("kind", k)}
                className={cn(
                  "h-6 flex-1 rounded text-[12px] capitalize text-muted-foreground",
                  form.kind === k && "bg-accent text-foreground",
                )}
              >
                {k}
              </button>
            ))}
          </div>
        )}
        <Field label="Name">
          <input
            autoFocus={!contact}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={form.kind === "company" ? "Al Hattab Group" : "Mohamed Mohsen"}
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Type">
            <select
              value={form.relationship}
              onChange={(e) => set("relationship", e.target.value as Relationship | "")}
              className={inputCls}
            >
              {RELATIONSHIP_ORDER.map((r) => (
                <option key={r} value={r}>
                  {RELATIONSHIP_META[r].label}
                </option>
              ))}
              {contact && <option value="">Not in CRM</option>}
            </select>
          </Field>
          <Field label="Owner">
            <select value={form.owner} onChange={(e) => set("owner", e.target.value)} className={inputCls}>
              <option value="">No owner</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {userLabel(u)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Headline">
          <input
            value={form.headline}
            onChange={(e) => set("headline", e.target.value)}
            placeholder={
              form.kind === "company"
                ? "Construction group — interiors, contracting"
                : "Regional Director of BIM"
            }
            className={inputCls}
          />
        </Field>
        {form.kind === "person" && (
          <Field label="Company">
            <input
              value={form.company}
              onChange={(e) => set("company", e.target.value)}
              placeholder="Created if new"
              className={inputCls}
            />
          </Field>
        )}
        <Field label="Emails">
          <input
            value={form.emails}
            onChange={(e) => set("emails", e.target.value)}
            placeholder="name@company.com, …"
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Phone">
            <input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+974 …" className={inputCls} />
          </Field>
          <Field label="WhatsApp">
            <input
              value={form.whatsapp}
              onChange={(e) => set("whatsapp", e.target.value)}
              placeholder="Same as phone"
              className={inputCls}
            />
          </Field>
        </div>
        <Field label={form.kind === "company" ? "Website" : "LinkedIn"}>
          {form.kind === "company" ? (
            <input value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" className={inputCls} />
          ) : (
            <input
              value={form.linkedin_url}
              onChange={(e) => set("linkedin_url", e.target.value)}
              placeholder="https://linkedin.com/in/…"
              className={inputCls}
            />
          )}
        </Field>
        <Field label="Wiki page">
          <input
            value={form.wiki_slug}
            onChange={(e) => set("wiki_slug", e.target.value)}
            placeholder={form.kind === "company" ? "entities/companies/…" : "entities/people/…"}
            className={cn(inputCls, "font-mono text-[12px]")}
          />
        </Field>
      </div>

      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving || !form.name.trim()}>
          {saving ? "Saving…" : contact ? "Save" : "Add to CRM"}
        </Button>
      </DialogFooter>
    </form>
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
