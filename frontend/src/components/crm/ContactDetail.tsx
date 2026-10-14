"use client";

/**
 * One person or company: who they are (position, company, channels), their
 * leads, and every update that concerns them — a company's include its
 * people's — with a composer on top.
 *
 * The bio is deliberately absent: the story lives in the LLM wiki, linked
 * from the header.
 */

import { useState } from "react";
import {
  AudioLines,
  BriefcaseBusiness,
  Globe,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  X,
} from "lucide-react";

import { type ContactDetail as Detail, useContact } from "@/hooks/use-crm";
import {
  companyDomain,
  errorMessage,
  relativeDay,
  stageLabel,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { ContactEditDialog } from "./ContactEditDialog";
import { UpdateComposer } from "./UpdateComposer";
import { UpdateFeed } from "./UpdateFeed";
import {
  CompanyMark,
  ContactAvatar,
  KindIcon,
  SectionHeader,
  controlCls,
  ghostBtnCls,
} from "./shared";

export function ContactDetail({
  contactId,
  onClose,
  onOpenContact,
  onOpenLead,
  onNewLead,
}: {
  contactId: number;
  onClose: () => void;
  onOpenContact: (id: number) => void;
  onOpenLead: (key: string) => void;
  onNewLead: (company: { id: number; name: string } | null) => void;
}) {
  const contact = useContact(contactId);
  const [editing, setEditing] = useState(false);

  if (contact.isLoading) {
    return (
      <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
    );
  }
  if (contact.isError || !contact.data) {
    return (
      <div className="p-4 text-[13px] text-destructive">
        {errorMessage(contact.error) || "Couldn’t load this contact."}
      </div>
    );
  }
  const c = contact.data;
  const company =
    c.kind === "company" ? { id: c.id, kind: c.kind, name: c.name } : c.company;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-start gap-3">
          <ContactAvatar
            name={c.name}
            kind={c.kind}
            domain={companyDomain(c.website, c.emails)}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <KindIcon kind={c.kind} className="size-3" />
              <span>{c.kind === "company" ? "Company" : "Person"}</span>
              {c.meeting_count > 0 && (
                <a
                  href={`/meetings?view=list&entity=${c.id}`}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  · <AudioLines className="size-3" /> {c.meeting_count} meeting
                  {c.meeting_count === 1 ? "" : "s"}
                </a>
              )}
            </div>
            <h1 className="mt-0.5 truncate text-[16px] font-semibold leading-snug">
              {c.name}
            </h1>
            {(c.position || c.company) && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
                {c.position && <span className="truncate">{c.position}</span>}
                {c.position && c.company && <span>·</span>}
                {c.company && (
                  <button
                    type="button"
                    onClick={() => onOpenContact(c.company!.id)}
                    className="inline-flex min-w-0 items-center gap-1 truncate hover:text-foreground hover:underline"
                  >
                    <CompanyMark domain={companyDomain(c.company.website)} />
                    {c.company.name}
                  </button>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Edit contact"
            onClick={() => setEditing(true)}
            className="tap-target grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Pencil className="size-3.5" />
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
        <Channels contact={c} onEdit={() => setEditing(true)} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <SectionHeader
          title="Leads"
          count={c.leads.length}
          action={
            <button
              type="button"
              className={ghostBtnCls}
              onClick={() => onNewLead(company)}
            >
              <Plus className="size-3.5" /> Lead
            </button>
          }
        />
        {c.leads.length > 0 ? (
          <ul className="space-y-1 px-4">
            {c.leads.map((l) => (
              <li key={l.key}>
                <button
                  type="button"
                  onClick={() => onOpenLead(l.key)}
                  className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent/40"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {l.title}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border border-border px-1.5 text-[11px]",
                      l.stage === "won" &&
                        "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
                      l.stage === "lost" &&
                        "text-muted-foreground line-through",
                    )}
                  >
                    {stageLabel(l.stage)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 text-[12px] text-muted-foreground">No leads.</p>
        )}

        {c.kind === "company" && (
          <>
            <SectionHeader title="People" count={c.people.length} />
            {c.people.length > 0 ? (
              <ul className="px-2">
                {c.people.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onOpenContact(p.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
                    >
                      <ContactAvatar name={p.name} kind="person" size="sm" />
                      <span className="truncate text-[13px]">{p.name}</span>
                      {p.position && (
                        <span className="truncate text-[12px] text-muted-foreground max-sm:hidden">
                          {p.position}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
                        {p.last_update ? relativeDay(p.last_update.at) : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 text-[12px] text-muted-foreground">
                No people linked yet.
              </p>
            )}
          </>
        )}

        <SectionHeader title="Updates" count={c.updates.length} />
        <Composer contact={c} />
        <UpdateFeed
          updates={c.updates}
          showLead
          onOpenContact={onOpenContact}
          onOpenLead={onOpenLead}
        />
      </div>

      <ContactEditDialog open={editing} onOpenChange={setEditing} contact={c} />
    </div>
  );
}

/** The composer, aimed at one of the contact's open leads (or none). */
function Composer({ contact: c }: { contact: Detail }) {
  const open = c.leads.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const [lead, setLead] = useState(open[0]?.key ?? "");
  const current = c.leads.find((l) => l.key === lead);
  const company =
    c.kind === "company" ? { id: c.id, kind: c.kind, name: c.name } : c.company;
  const self =
    c.kind === "person" ? [{ id: c.id, kind: c.kind, name: c.name }] : [];
  return (
    <>
      {c.leads.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 pt-2 text-[12px] text-muted-foreground">
          On
          <select
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            className={cn(controlCls, "h-6")}
          >
            <option value="">No lead</option>
            {c.leads.map((l) => (
              <option key={l.key} value={l.key}>
                {l.title}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="px-4 pb-1 pt-2">
        <UpdateComposer
          key={lead}
          lead={lead || undefined}
          company={company}
          suggested={self}
          preselect={self.map((p) => p.id)}
          canFile={!!current?.project}
          placeholder={`What happened with ${c.name}?`}
        />
      </div>
    </>
  );
}

function Channels({
  contact: c,
  onEdit,
}: {
  contact: Detail;
  onEdit: () => void;
}) {
  const links: {
    href: string;
    label: string;
    icon: typeof Phone;
    external?: boolean;
  }[] = [];
  if (c.phone) {
    links.push({
      href: `tel:${c.phone.replace(/\s/g, "")}`,
      label: c.phone,
      icon: Phone,
    });
    // wa.me wants digits only, with country code.
    links.push({
      href: `https://wa.me/${c.phone.replace(/[^\d]/g, "")}`,
      label: "WhatsApp",
      icon: MessageCircle,
      external: true,
    });
  }
  for (const email of c.emails)
    links.push({ href: `mailto:${email}`, label: email, icon: Mail });
  if (c.linkedin_url)
    links.push({
      href: c.linkedin_url,
      label: "LinkedIn",
      icon: BriefcaseBusiness,
      external: true,
    });
  if (c.website)
    links.push({
      href: c.website,
      label: c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""),
      icon: Globe,
      external: true,
    });
  if (c.wiki_slug)
    links.push({
      href: `/llm-wiki#w/${c.wiki_slug}`,
      label: "Wiki",
      icon: Sparkles,
    });

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          {...(l.external
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
          className="tap-target inline-flex h-6 max-w-56 items-center gap-1 rounded-md border border-border px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <l.icon className="size-3 shrink-0" />
          <span className="truncate">{l.label}</span>
        </a>
      ))}
      {links.length === 0 && (
        <button
          type="button"
          onClick={onEdit}
          className={cn(ghostBtnCls, "h-6 px-1.5")}
        >
          <Plus className="size-3" /> Add phone, email, LinkedIn…
        </button>
      )}
    </div>
  );
}
