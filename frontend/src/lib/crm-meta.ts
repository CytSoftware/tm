/**
 * Shared presentation metadata for the CRM: relationship labels + pill
 * styles, touchpoint kinds, and the date phrasing every view uses.
 *
 * Relationship is never carried by color alone — every pill names it.
 */

import {
  differenceInCalendarDays,
  format,
  isThisYear,
} from "date-fns";
import {
  Building2,
  CalendarDays,
  History,
  Inbox,
  Kanban,
  Mail,
  MessageCircle,
  NotebookPen,
  Phone,
  Sparkle,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { Relationship, StageKind, TouchpointKind } from "@/hooks/use-crm";
import { ApiError } from "@/lib/api";

/** Prefix of the project follow-up tasks live in (not a business scope). */
export const CRM_PROJECT_PREFIX = "FUP";

/** The CRM's sections, in order — rendered as sub-items under CRM in the
 *  sidebar and selected by `/crm?tab=<id>` (`inbox` is the bare `/crm`). */
export const CRM_SECTIONS = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "people", label: "People", icon: Users },
  { id: "companies", label: "Companies", icon: Building2 },
  { id: "deals", label: "Deals", icon: Kanban },
  { id: "activity", label: "Activity", icon: History },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type CrmSection = (typeof CRM_SECTIONS)[number]["id"];

export function crmSectionHref(
  id: CrmSection,
  keep: Record<string, string | null | undefined> = {},
): string {
  const qs = new URLSearchParams();
  if (id !== "inbox") qs.set("tab", id);
  for (const [k, v] of Object.entries(keep)) if (v) qs.set(k, v);
  const query = qs.toString();
  return query ? `/crm?${query}` : "/crm";
}

export const RELATIONSHIP_META: Record<
  Relationship,
  { label: string; pill: string }
> = {
  client: {
    label: "Client",
    pill: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
  },
  lead: {
    label: "Lead",
    pill: "bg-sky-500/12 text-sky-700 dark:text-sky-300 border-sky-500/25",
  },
  partner: {
    label: "Partner",
    pill: "bg-violet-500/12 text-violet-700 dark:text-violet-300 border-violet-500/25",
  },
  investor: {
    label: "Investor",
    pill: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25",
  },
  advisor: {
    label: "Advisor",
    pill: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25",
  },
  other: {
    label: "Other",
    pill: "bg-muted text-muted-foreground border-border",
  },
  internal: {
    label: "Internal",
    pill: "bg-muted text-muted-foreground border-border",
  },
};

/** Order in pickers and filter chips; `internal` last (hidden by default). */
export const RELATIONSHIP_ORDER: Relationship[] = [
  "lead",
  "client",
  "partner",
  "investor",
  "advisor",
  "other",
  "internal",
];

export const TOUCHPOINT_META: Record<
  TouchpointKind,
  { label: string; icon: LucideIcon }
> = {
  call: { label: "Call", icon: Phone },
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  email: { label: "Email", icon: Mail },
  calendar: { label: "Calendar", icon: CalendarDays },
  note: { label: "Note", icon: NotebookPen },
  other: { label: "Other", icon: Sparkle },
};

export const TOUCHPOINT_ORDER: TouchpointKind[] = [
  "note",
  "call",
  "whatsapp",
  "email",
  "calendar",
  "other",
];

export const STAGE_KIND_LABEL: Record<StageKind, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
};

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

/** Due before today — by calendar day, matching the inbox buckets (a 09:00
 *  follow-up isn't "overdue" at 10:00 the same day). */
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

export function formatMoney(value: string | null, currency = "QAR"): string {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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

/** wa.me wants digits only, with country code. */
export function whatsappUrl(number: string): string {
  return `https://wa.me/${number.replace(/[^\d]/g, "")}`;
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
