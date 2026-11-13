/**
 * Shared presentation metadata for the CRM: sections, board stages, update
 * kinds, and the date phrasing every view uses.
 */

import {
  differenceInCalendarDays,
  format,
  isThisYear,
  parseISO,
} from "date-fns";
import {
  AudioLines,
  Banknote,
  Building2,
  History,
  KeyRound,
  Kanban,
  Mail,
  MessageCircle,
  NotebookPen,
  Phone,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { LeadStage, Licence, LostReason, PaymentStatus, PaymentType, UpdateKind } from "@/hooks/use-crm";
import { ApiError } from "@/lib/api";

/** The CRM's sections, in order — rendered as sub-items under CRM in the
 *  sidebar and selected by `/crm?tab=<id>` (`leads` is the bare `/crm`). */
export const CRM_SECTIONS = [
  { id: "leads", label: "Leads", icon: Kanban },
  { id: "activity", label: "Activity", icon: History },
  { id: "people", label: "People", icon: Users },
  { id: "companies", label: "Companies", icon: Building2 },
  { id: "billing", label: "Billing", icon: Banknote },
  { id: "licences", label: "Licences", icon: KeyRound },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type CrmSection = (typeof CRM_SECTIONS)[number]["id"];

export function crmSectionHref(
  id: CrmSection,
  keep: Record<string, string | null | undefined> = {},
): string {
  const qs = new URLSearchParams();
  if (id !== "leads") qs.set("tab", id);
  for (const [k, v] of Object.entries(keep)) if (v) qs.set(k, v);
  const query = qs.toString();
  return query ? `/crm?${query}` : "/crm";
}

/** Board columns, in order (mirrors ``LeadStage`` in apps/crm/models.py).
 * Each is named after what happened, not a win probability. */
export const STAGES: { id: LeadStage; label: string; dot: string }[] = [
  { id: "potential", label: "Potential", dot: "bg-muted-foreground/50" },
  { id: "outreach", label: "Outreach", dot: "bg-sky-500" },
  { id: "in_talks", label: "In talks", dot: "bg-sky-500" },
  { id: "offer", label: "Pilot / Proposal", dot: "bg-sky-500" },
  { id: "later", label: "Later", dot: "bg-amber-500" },
  { id: "won", label: "Won", dot: "bg-emerald-500" },
  { id: "lost", label: "Lost", dot: "bg-muted-foreground/40" },
];

/** Mirrors ``LostReason`` in apps/crm/models.py. */
export const LOST_REASONS: { id: LostReason; label: string }[] = [
  { id: "no_response", label: "No response" },
  { id: "no_fit", label: "No fit" },
  { id: "chose_other", label: "Chose another tool" },
  { id: "no_budget", label: "No budget" },
];

export const stageLabel = (id: LeadStage) => STAGES.find((s) => s.id === id)?.label ?? id;

export const UPDATE_KINDS: { id: UpdateKind; label: string; icon: LucideIcon }[] = [
  { id: "note", label: "Note", icon: NotebookPen },
  { id: "message", label: "Message", icon: MessageCircle },
  { id: "call", label: "Call", icon: Phone },
  { id: "email", label: "Email", icon: Mail },
  { id: "meeting", label: "Meeting", icon: AudioLines },
];

export const updateKindMeta = (id: UpdateKind) =>
  UPDATE_KINDS.find((k) => k.id === id) ?? UPDATE_KINDS[0];

/** "3d ago" / "in 2d" / "today" — for last contact and due dates. */
export function relativeDay(iso: string | null): string {
  if (!iso) return "—";
  const days = differenceInCalendarDays(new Date(iso), new Date());
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (Math.abs(days) < 45) return days < 0 ? `${-days}d ago` : `in ${days}d`;
  // Past six weeks a date reads better than "5 months ago".
  return shortDate(iso);
}

/** Due before today — by calendar day (a 09:00 next step isn't "overdue" at
 *  10:00 the same day). */
export function isOverdue(iso: string | null): boolean {
  return !!iso && differenceInCalendarDays(new Date(iso), new Date()) < 0;
}

/** "Oct 8" this year, "Oct 8, 2025" otherwise. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return format(d, isThisYear(d) ? "MMM d" : "MMM d, yyyy");
}

/** `yyyy-MM-dd` for <input type="date">, `n` days from today. */
export function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return format(d, "yyyy-MM-dd");
}

/** The local calendar day of an ISO timestamp, as `yyyy-MM-dd`. */
export function dayOf(iso: string | null): string {
  return iso ? format(new Date(iso), "yyyy-MM-dd") : "";
}

export function userLabel(u: { first_name: string; last_name: string; username: string } | null) {
  if (!u) return "Unassigned";
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const p = err.payload as Record<string, unknown> | null;
    const d = p?.detail;
    if (d) return Array.isArray(d) ? d.join(" ") : String(d);
    if (p && typeof p === "object") {
      const first = Object.entries(p)[0];
      if (first) return `${first[0]}: ${[first[1]].flat().join(" ")}`;
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** Personal-mail hosts: an address there says nothing about the company. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

/** The domain a company's logo is looked up by: its website, else the first
 *  work address on file. Empty when there's nothing to go on. */
export function companyDomain(website?: string | null, emails: string[] = []): string {
  const site = (website ?? "").trim();
  if (site) {
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`);
      return url.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      // fall through to email
    }
  }
  for (const email of emails) {
    const host = email.split("@")[1]?.toLowerCase();
    if (host && !FREE_MAIL.has(host)) return host;
  }
  return "";
}

/** Favicon-service URL for a domain. Unknown domains come back as a 16px
 *  placeholder globe, which `CompanyLogo` treats as "no logo". */
export function logoUrl(domain: string, px = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${px}`;
}

/** Mirrors ``PaymentType`` in apps/crm/models.py. */
export const PAYMENT_TYPES: { id: PaymentType; label: string }[] = [
  { id: "licence", label: "Licence" },
  { id: "retainer", label: "Retainer" },
  { id: "down_payment", label: "Down payment" },
  { id: "instalment", label: "Instalment" },
  { id: "one_off", label: "One-off" },
];

export const paymentTypeLabel = (id: PaymentType) =>
  PAYMENT_TYPES.find((t) => t.id === id)?.label ?? id;


export const PAYMENT_STATUS: Record<PaymentStatus, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "text-emerald-700 dark:text-emerald-400" },
  overdue: { label: "Overdue", cls: "text-destructive" },
  upcoming: { label: "Upcoming", cls: "text-muted-foreground" },
};

/** "QAR 60,000" — every amount is QAR. */
export const money = (n: number) => `QAR ${Math.round(n).toLocaleString("en-US")}`;

/** A `yyyy-MM-dd` day (not a timestamp) read in local time, "Dec 5" style. */
export const shortDay = (day: string | null) => (day ? shortDate(parseISO(day).toISOString()) : "—");

/** Calendar days from today to a `yyyy-MM-dd` day (negative = past). */
export const daysUntil = (day: string) => differenceInCalendarDays(parseISO(day), new Date());

/** How a licence reads in a list: lapsed = ended and nobody renewed it. */
export function licenceState(l: Licence): { label: string; cls: string } {
  const days = daysUntil(l.ends_on);
  if (l.status === "upcoming") return { label: `Starts ${shortDay(l.starts_on)}`, cls: "text-muted-foreground" };
  if (l.status === "ended")
    return l.renewed
      ? { label: `Renewed · ended ${shortDay(l.ends_on)}`, cls: "text-muted-foreground" }
      : { label: `Lapsed ${shortDay(l.ends_on)}`, cls: "text-destructive" };
  if (l.status === "expiring" && !l.renewed)
    return { label: `Ends in ${days}d`, cls: "text-amber-700 dark:text-amber-400" };
  return { label: `Active · until ${shortDay(l.ends_on)}`, cls: "text-emerald-700 dark:text-emerald-400" };
}
