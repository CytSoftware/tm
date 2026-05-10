"use client";

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { CountrySelect } from "@/components/crm/CountrySelect";
import {
  useContactLabelsQuery,
  useContactQuery,
  useDeleteContact,
  useUpdateContact,
} from "@/hooks/use-contacts";
import { SOCIAL_KEYS, SOCIAL_LABELS, type SocialKey } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  contactKey: string | null;
  onClose: () => void;
};

/**
 * Slide-out detail panel — same shape as PipelinePanel.
 *
 * Edits flush on blur per-field (no global "save" button). The optimistic
 * model is "the row is the source of truth"; if the user navigates away mid-
 * edit, the in-flight blur still fires.
 */
export function ContactPanel({ contactKey, onClose }: Props) {
  const contactQuery = useContactQuery(contactKey);
  const labelsQuery = useContactLabelsQuery();
  const updateContact = useUpdateContact();
  const deleteContact = useDeleteContact();

  const contact = contactQuery.data;

  // Local edit buffer — seeded from the loaded contact via the
  // "previous-render compare" pattern PipelinePanel uses.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [company, setCompany] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [industry, setIndustry] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [addr1, setAddr1] = useState("");
  const [addr2, setAddr2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState("");
  const [notes, setNotes] = useState("");
  const [websitesText, setWebsitesText] = useState("");
  const [socialDraft, setSocialDraft] = useState<
    Partial<Record<SocialKey, string>>
  >({});

  if (contact && seededFor !== contact.key) {
    setSeededFor(contact.key);
    setCompany(contact.company);
    setFirstName(contact.first_name);
    setLastName(contact.last_name);
    setIndustry(contact.industry);
    setJobTitle(contact.job_title);
    setEmail(contact.email);
    setPhone(contact.phone);
    setAddr1(contact.address_line1);
    setAddr2(contact.address_line2);
    setCity(contact.city);
    setRegion(contact.region);
    setPostal(contact.postal_code);
    setCountry(contact.country);
    setNotes(contact.notes);
    setWebsitesText((contact.websites || []).join("\n"));
    setSocialDraft({ ...contact.socials });
  }

  if (!contactKey) return null;

  function patch(payload: Record<string, unknown>) {
    if (!contactKey) return;
    updateContact.mutate({ key: contactKey, ...payload });
  }

  function flushString(field: keyof typeof simpleMap, current: string) {
    if (!contact) return;
    const original = simpleMap[field](contact);
    if (current === original) return;
    patch({ [field]: current });
  }

  // Field name → getter on the loaded contact, so the blur handler can short-
  // circuit when nothing changed.
  const simpleMap = {
    company: (c: typeof contact) => (c ? c.company : ""),
    first_name: (c: typeof contact) => (c ? c.first_name : ""),
    last_name: (c: typeof contact) => (c ? c.last_name : ""),
    industry: (c: typeof contact) => (c ? c.industry : ""),
    job_title: (c: typeof contact) => (c ? c.job_title : ""),
    email: (c: typeof contact) => (c ? c.email : ""),
    phone: (c: typeof contact) => (c ? c.phone : ""),
    address_line1: (c: typeof contact) => (c ? c.address_line1 : ""),
    address_line2: (c: typeof contact) => (c ? c.address_line2 : ""),
    city: (c: typeof contact) => (c ? c.city : ""),
    region: (c: typeof contact) => (c ? c.region : ""),
    postal_code: (c: typeof contact) => (c ? c.postal_code : ""),
    notes: (c: typeof contact) => (c ? c.notes : ""),
  } as const;

  function flushWebsites() {
    if (!contact) return;
    const next = websitesText
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const current = contact.websites || [];
    if (next.length === current.length && next.every((u, i) => u === current[i])) {
      return;
    }
    patch({ websites: next });
  }

  function flushSocial(key: SocialKey, value: string) {
    if (!contact) return;
    const current = (contact.socials || {})[key] ?? "";
    const next = value.trim();
    if (next === current) return;
    patch({ socials: { ...contact.socials, [key]: next } });
  }

  function toggleLabel(labelId: number) {
    if (!contact) return;
    const has = contact.labels.some((l) => l.id === labelId);
    const nextIds = has
      ? contact.labels.filter((l) => l.id !== labelId).map((l) => l.id)
      : [...contact.labels.map((l) => l.id), labelId];
    patch({ label_ids: nextIds });
  }

  function handleDelete() {
    if (!contactKey) return;
    if (!confirm(`Delete contact ${contactKey}? This cannot be undone.`))
      return;
    deleteContact.mutate(contactKey, {
      onSuccess: () => onClose(),
    });
  }

  return (
    <aside className="shrink-0 w-[420px] h-full flex flex-col border-l border-border/80 bg-background">
      <header className="shrink-0 flex items-center gap-2 px-4 h-12 border-b border-border/80">
        <span className="font-mono text-[11px] text-muted-foreground tracking-wider uppercase">
          {contactKey}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={handleDelete}
          aria-label="Delete contact"
        >
          <Trash2 className="size-3.5 text-destructive" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
        {contactQuery.isLoading && (
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        )}
        {contact && (
          <>
            <Section title="Identity">
              <Field label="Company">
                <Input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  onBlur={() => flushString("company", company)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name">
                  <Input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    onBlur={() => flushString("first_name", firstName)}
                  />
                </Field>
                <Field label="Last name">
                  <Input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    onBlur={() => flushString("last_name", lastName)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Industry">
                  <Input
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    onBlur={() => flushString("industry", industry)}
                    placeholder="Banking, SaaS, Manufacturing…"
                  />
                </Field>
                <Field label="Job title">
                  <Input
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                    onBlur={() => flushString("job_title", jobTitle)}
                    placeholder="CEO, Engineer, Sales Lead…"
                  />
                </Field>
              </div>
            </Section>

            <Section title="Contact">
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => flushString("email", email)}
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onBlur={() => flushString("phone", phone)}
                />
              </Field>
            </Section>

            <Section title="Address">
              <Field label="Address line 1">
                <Input
                  value={addr1}
                  onChange={(e) => setAddr1(e.target.value)}
                  onBlur={() => flushString("address_line1", addr1)}
                />
              </Field>
              <Field label="Address line 2">
                <Input
                  value={addr2}
                  onChange={(e) => setAddr2(e.target.value)}
                  onBlur={() => flushString("address_line2", addr2)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City">
                  <Input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    onBlur={() => flushString("city", city)}
                  />
                </Field>
                <Field label="Region / State">
                  <Input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    onBlur={() => flushString("region", region)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Postal code">
                  <Input
                    value={postal}
                    onChange={(e) => setPostal(e.target.value)}
                    onBlur={() => flushString("postal_code", postal)}
                  />
                </Field>
                <Field label="Country">
                  <CountrySelect
                    value={country}
                    onChange={(c) => {
                      setCountry(c);
                      patch({ country: c });
                    }}
                    className="w-full"
                  />
                </Field>
              </div>
            </Section>

            <Section title="Web">
              <Field label="Websites (one per line)">
                <Textarea
                  rows={3}
                  value={websitesText}
                  onChange={(e) => setWebsitesText(e.target.value)}
                  onBlur={flushWebsites}
                  placeholder="https://example.com"
                />
              </Field>
              {SOCIAL_KEYS.map((sk) => (
                <Field key={sk} label={SOCIAL_LABELS[sk]}>
                  <Input
                    value={socialDraft[sk] ?? ""}
                    onChange={(e) =>
                      setSocialDraft((prev) => ({ ...prev, [sk]: e.target.value }))
                    }
                    onBlur={() => flushSocial(sk, socialDraft[sk] ?? "")}
                    placeholder={`https://${sk}.com/…`}
                  />
                </Field>
              ))}
            </Section>

            <Section title="Labels">
              <div className="flex flex-wrap gap-1.5">
                {contact.labels.map((l) => (
                  <Badge
                    key={l.id}
                    variant="secondary"
                    style={{
                      backgroundColor: `${l.color}22`,
                      color: l.color,
                      border: `1px solid ${l.color}44`,
                    }}
                    className="cursor-pointer"
                    onClick={() => toggleLabel(l.id)}
                  >
                    {l.name}
                    <X className="size-3 ml-0.5" />
                  </Badge>
                ))}
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button variant="outline" size="sm" className="h-6 text-[11px]">
                        <Plus className="size-3" />
                        Add
                      </Button>
                    }
                  />
                  <PopoverContent align="start" className="w-56 p-1">
                    <div className="max-h-64 overflow-y-auto">
                      {(labelsQuery.data ?? []).map((l) => {
                        const attached = contact.labels.some(
                          (cl) => cl.id === l.id,
                        );
                        return (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => toggleLabel(l.id)}
                            className={cn(
                              "w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-muted/60",
                              attached && "bg-muted/40",
                            )}
                          >
                            <span
                              className="size-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: l.color }}
                            />
                            <span className="truncate flex-1 text-left">
                              {l.name}
                            </span>
                            {attached && <span className="text-[10px]">✓</span>}
                          </button>
                        );
                      })}
                      {(labelsQuery.data ?? []).length === 0 && (
                        <div className="px-2 py-2 text-[12px] text-muted-foreground italic">
                          No labels yet — create one from the page header.
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </Section>

            <Section title="Notes">
              <Textarea
                rows={5}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => flushString("notes", notes)}
              />
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
