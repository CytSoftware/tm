"use client";

/**
 * One contact: who they are (channels, owner, type), what we owe them
 * (follow-ups), what's in play (deals) and everything that happened (the
 * timeline — meetings, touchpoints, closed follow-ups, derived server-side).
 *
 * The bio is deliberately absent: the story lives in the LLM wiki, linked
 * from the header. The CRM only holds state.
 */

import { useState } from "react";
import {
  AudioLines,
  CheckCircle2,
  Globe,
  BriefcaseBusiness,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  type ContactDetail as Detail,
  type Relationship,
  type TouchpointKind,
  useContact,
  useLogTouchpoint,
  useUpdateContact,
} from "@/hooks/use-crm";
import { useUsersQuery } from "@/hooks/use-users";
import {
  RELATIONSHIP_META,
  RELATIONSHIP_ORDER,
  TOUCHPOINT_META,
  TOUCHPOINT_ORDER,
  companyDomain,
  errorMessage,
  formatMoney,
  isOverdue,
  isoDay,
  relativeDay,
  userLabel,
  whatsappUrl,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { ActivityTimeline } from "./ActivityTimeline";
import { ContactEditDialog } from "./ContactEditDialog";
import { FollowUpRow, QuickFollowUp } from "./InboxView";
import {
  CompanyMark,
  ContactAvatar,
  KindIcon,
  RelationshipPill,
  SectionHeader,
  controlCls,
  ghostBtnCls,
} from "./shared";

export function ContactDetail({
  contactId,
  onClose,
  onOpenContact,
  onOpenDeal,
  onNewDeal,
}: {
  contactId: number;
  onClose: () => void;
  onOpenContact: (id: number) => void;
  onOpenDeal: (key: string) => void;
  onNewDeal: (company: { id: number; name: string } | null) => void;
}) {
  const contact = useContact(contactId);
  const [editing, setEditing] = useState(false);
  const [addingFollowUp, setAddingFollowUp] = useState(false);

  if (contact.isLoading) {
    return <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>;
  }
  if (contact.isError || !contact.data) {
    return (
      <div className="p-4 text-[13px] text-destructive">
        {errorMessage(contact.error) || "Couldn’t load this contact."}
      </div>
    );
  }
  const c = contact.data;
  const companyForDeal =
    c.kind === "company" ? { id: c.id, name: c.name } : c.company;

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
            <h1 className="mt-0.5 truncate text-[16px] font-semibold leading-snug">{c.name}</h1>
            {(c.headline || c.company) && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
                {c.headline && <span className="truncate">{c.headline}</span>}
                {c.headline && c.company && <span>·</span>}
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

        <StateBar contact={c} />
        <Channels contact={c} onEdit={() => setEditing(true)} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <QuickLog contact={c} />

        <SectionHeader
          title="Follow-ups"
          count={c.follow_ups.length}
          action={
            !addingFollowUp && (
              <button type="button" className={ghostBtnCls} onClick={() => setAddingFollowUp(true)}>
                <Plus className="size-3.5" /> Add
              </button>
            )
          }
        />
        {addingFollowUp && (
          <div className="px-4 pb-2">
            <QuickFollowUp
              entityId={c.id}
              placeholder={`What do we owe ${c.name}?`}
              onDone={() => setAddingFollowUp(false)}
            />
          </div>
        )}
        {c.follow_ups.length > 0 ? (
          <ul className="divide-y divide-border/60">
            {c.follow_ups.map((f) => (
              <FollowUpRow
                key={f.id}
                followUp={f}
                compact={f.entity.id === c.id}
                overdue={isOverdue(f.due_at)}
                onOpenContact={onOpenContact}
              />
            ))}
          </ul>
        ) : (
          !addingFollowUp && (
            <p className="px-4 text-[12px] text-muted-foreground">No next step scheduled.</p>
          )
        )}

        <SectionHeader
          title="Deals"
          count={c.deals.length}
          action={
            <button type="button" className={ghostBtnCls} onClick={() => onNewDeal(companyForDeal)}>
              <Plus className="size-3.5" /> Deal
            </button>
          }
        />
        {c.deals.length > 0 ? (
          <ul className="space-y-1 px-4">
            {c.deals.map((d) => (
              <li key={d.key}>
                <button
                  type="button"
                  onClick={() => onOpenDeal(d.key)}
                  className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent/40"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{d.title}</span>
                  {d.value && (
                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {formatMoney(d.value, d.currency)}
                    </span>
                  )}
                  <span
                    className={cn(
                      "shrink-0 rounded-full border border-border px-1.5 text-[11px]",
                      d.stage.kind === "won" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
                      d.stage.kind === "lost" && "text-muted-foreground line-through",
                    )}
                  >
                    {d.stage.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 text-[12px] text-muted-foreground">No deals.</p>
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
                      {p.headline && (
                        <span className="truncate text-[12px] text-muted-foreground max-sm:hidden">{p.headline}</span>
                      )}
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        <span className="text-[12px] text-muted-foreground">
                          {p.last_contact_at ? relativeDay(p.last_contact_at) : ""}
                        </span>
                        <RelationshipPill relationship={p.relationship} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 text-[12px] text-muted-foreground">No people linked yet.</p>
            )}
          </>
        )}

        <SectionHeader title="Timeline" count={c.timeline.length} />
        <ActivityTimeline items={c.timeline} onOpenContact={onOpenContact} />
      </div>

      <ContactEditDialog open={editing} onOpenChange={setEditing} contact={c} />
    </div>
  );
}

// ── Type / owner ────────────────────────────────────────────────────────────

function StateBar({ contact: c }: { contact: Detail }) {
  const update = useUpdateContact();
  const users = useUsersQuery();
  const save = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, { onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      <label className="relative">
        <span className="sr-only">Relationship</span>
        <select
          value={c.relationship}
          disabled={update.isPending}
          onChange={(e) =>
            save({ id: c.id, relationship: e.target.value as Relationship | "" })
          }
          className={cn(
            controlCls,
            "h-6 rounded-full pr-5 font-medium",
            c.relationship ? RELATIONSHIP_META[c.relationship].pill : "border-dashed",
          )}
        >
          {RELATIONSHIP_ORDER.map((r) => (
            <option key={r} value={r}>
              {RELATIONSHIP_META[r].label}
            </option>
          ))}
          <option value="">Not in CRM</option>
        </select>
      </label>
      <label>
        <span className="sr-only">Owner</span>
        <select
          value={c.owner?.id ?? ""}
          disabled={update.isPending}
          onChange={(e) =>
            save({ id: c.id, owner: e.target.value ? Number(e.target.value) : null })
          }
          className={cn(controlCls, "h-6")}
        >
          <option value="">No owner</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {userLabel(u)}
            </option>
          ))}
        </select>
      </label>
      <span className="ml-auto text-[12px] text-muted-foreground">
        {c.last_contact_at
          ? `Last contact ${relativeDay(c.last_contact_at)}`
          : "Never contacted"}
      </span>
    </div>
  );
}

// ── Channels ────────────────────────────────────────────────────────────────

function Channels({ contact: c, onEdit }: { contact: Detail; onEdit: () => void }) {
  const links: { href: string; label: string; icon: typeof Phone; external?: boolean }[] = [];
  if (c.phone) links.push({ href: `tel:${c.phone.replace(/\s/g, "")}`, label: c.phone, icon: Phone });
  const wa = c.whatsapp || c.phone;
  if (wa) links.push({ href: whatsappUrl(wa), label: "WhatsApp", icon: MessageCircle, external: true });
  for (const email of c.emails) links.push({ href: `mailto:${email}`, label: email, icon: Mail });
  if (c.linkedin_url) links.push({ href: c.linkedin_url, label: "LinkedIn", icon: BriefcaseBusiness, external: true });
  if (c.website)
    links.push({
      href: c.website,
      label: c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""),
      icon: Globe,
      external: true,
    });
  if (c.wiki_slug)
    links.push({ href: `/llm-wiki#w/${c.wiki_slug}`, label: "Wiki", icon: Sparkles });

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="tap-target inline-flex h-6 max-w-56 items-center gap-1 rounded-md border border-border px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <l.icon className="size-3 shrink-0" />
          <span className="truncate">{l.label}</span>
        </a>
      ))}
      {links.length === 0 && (
        <button type="button" onClick={onEdit} className={cn(ghostBtnCls, "h-6 px-1.5")}>
          <Plus className="size-3" /> Add phone, email, LinkedIn…
        </button>
      )}
    </div>
  );
}

// ── Quick log ───────────────────────────────────────────────────────────────

function QuickLog({ contact: c }: { contact: Detail }) {
  const log = useLogTouchpoint();
  const [kind, setKind] = useState<TouchpointKind>("note");
  const [summary, setSummary] = useState("");
  const [withFollowUp, setWithFollowUp] = useState(false);
  const [fuTitle, setFuTitle] = useState("");
  const [fuDue, setFuDue] = useState(isoDay(3));

  const submit = () => {
    if (!summary.trim()) return;
    log.mutate(
      {
        kind,
        summary: summary.trim(),
        entities: [c.id],
        follow_up:
          withFollowUp && fuTitle.trim()
            ? { title: fuTitle.trim(), due: fuDue || null }
            : null,
      },
      {
        onSuccess: () => {
          toast.success(`${TOUCHPOINT_META[kind].label} logged`);
          setSummary("");
          setFuTitle("");
          setWithFollowUp(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <form
      className="m-4 mb-1 rounded-lg border border-border focus-within:border-ring"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-0.5 overflow-x-auto border-b border-border/70 p-1">
        {TOUCHPOINT_ORDER.filter((k) => k !== "calendar").map((k) => {
          const Icon = TOUCHPOINT_META[k].icon;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "tap-target inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[12px] text-muted-foreground hover:text-foreground",
                kind === k && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-3" />
              {TOUCHPOINT_META[k].label}
            </button>
          );
        })}
      </div>
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={2}
        placeholder={`What happened with ${c.name}?`}
        className="block w-full resize-none bg-transparent px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground/60"
      />
      {withFollowUp && (
        <div className="flex items-center gap-1.5 px-2.5 pb-2">
          <input
            autoFocus
            value={fuTitle}
            onChange={(e) => setFuTitle(e.target.value)}
            placeholder="Next step — e.g. Send the pilot proposal"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring"
          />
          <input
            type="date"
            value={fuDue}
            onChange={(e) => setFuDue(e.target.value)}
            className="h-7 shrink-0 rounded-md border border-border bg-transparent px-1 text-[12px]"
          />
        </div>
      )}
      <div className="flex items-center gap-1 px-1.5 pb-1.5">
        <button
          type="button"
          aria-pressed={withFollowUp}
          onClick={() => setWithFollowUp((v) => !v)}
          className={cn(ghostBtnCls, withFollowUp && "text-foreground")}
        >
          <CheckCircle2 className="size-3.5" />
          {withFollowUp ? "With follow-up" : "Add follow-up"}
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground/60 max-lg:hidden">⌘↵</span>
        <button
          type="submit"
          disabled={!summary.trim() || log.isPending}
          className="tap-target h-7 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background disabled:opacity-40"
        >
          Log
        </button>
      </div>
    </form>
  );
}
