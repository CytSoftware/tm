/**
 * Shared presentation metadata for the CRM: sections, board stages, update
 * kinds, and the date phrasing every view uses.
 */

import {
  differenceInCalendarDays,
  format,
  isThisYear,
} from "date-fns";
import {
  AudioLines,
  Building2,
  History,
  Kanban,
  Mail,
  MessageCircle,
  NotebookPen,
  Phone,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { LeadStage, UpdateKind } from "@/hooks/use-crm";
import { ApiError } from "@/lib/api";

/** The CRM's sections, in order — rendered as sub-items under CRM in the
 *  sidebar and selected by `/crm?tab=<id>` (`leads` is the bare `/crm`). */
export const CRM_SECTIONS = [
  { id: "leads", label: "Leads", icon: Kanban },
  { id: "activity", label: "Activity", icon: History },
  { id: "people", label: "People", icon: Users },
  { id: "companies", label: "Companies", icon: Building2 },
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

/** Board columns, in order (mirrors ``LeadStage`` in apps/crm/models.py). */
export const STAGES: { id: LeadStage; label: string; dot: string }[] = [
  { id: "new", label: "New", dot: "bg-muted-foreground/50" },
  { id: "discovery", label: "Discovery", dot: "bg-sky-500" },
  { id: "demo", label: "Demo", dot: "bg-sky-500" },
  { id: "pilot", label: "Pilot", dot: "bg-sky-500" },
  { id: "proposal", label: "Proposal", dot: "bg-sky-500" },
  { id: "won", label: "Won", dot: "bg-emerald-500" },
  { id: "lost", label: "Lost", dot: "bg-muted-foreground/40" },
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
