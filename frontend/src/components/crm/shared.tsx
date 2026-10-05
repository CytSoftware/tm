"use client";

/** Small pieces every CRM view shares: pills, section headers, controls,
 *  table cells and form fields. */

import { useState } from "react";
import { Building2, User as UserIcon } from "lucide-react";

import type { EntityKind, Relationship } from "@/hooks/use-crm";
import { RELATIONSHIP_META, logoUrl } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

export const controlCls =
  "h-7 shrink-0 rounded-md border border-border bg-transparent px-1.5 text-[12px] text-foreground outline-none hover:bg-accent/50 focus-visible:border-ring disabled:opacity-50";

export const inputCls =
  "h-8 w-full min-w-0 rounded-md border border-border bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring";

export const ghostBtnCls =
  "tap-target inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";

export const primaryBtnCls =
  "tap-target inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background hover:bg-foreground/90 disabled:opacity-50";

export function RelationshipPill({
  relationship,
  className,
}: {
  relationship: Relationship | "";
  className?: string;
}) {
  if (!relationship) {
    return (
      <span
        className={cn(
          "inline-flex h-5 shrink-0 items-center rounded-full border border-dashed border-border px-1.5 text-[11px] text-muted-foreground",
          className,
        )}
      >
        Not in CRM
      </span>
    );
  }
  const meta = RELATIONSHIP_META[relationship];
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[11px] font-medium",
        meta.pill,
        className,
      )}
    >
      {meta.label}
    </span>
  );
}

export function KindIcon({ kind, className }: { kind: EntityKind; className?: string }) {
  const Icon = kind === "company" ? Building2 : UserIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export function SectionHeader({
  title,
  count,
  tone,
  action,
}: {
  title: string;
  count?: number;
  tone?: "danger";
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 pb-1 pt-4">
      <h2
        className={cn(
          "text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {title}
      </h2>
      {count != null && (
        <span className="text-[11px] tabular-nums text-muted-foreground/60">{count}</span>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

export function Empty({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "grid h-full min-h-40 place-items-center px-6 text-center text-[13px] text-muted-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

/** Initials tile — round for people, rounded-square for companies, so the
 *  two read apart at a glance even in a dense list. A company with a known
 *  domain shows its logo instead, falling back to the initials. */
export function ContactAvatar({
  name,
  kind,
  domain,
  size = "md",
}: {
  name: string;
  kind: EntityKind;
  /** See `companyDomain()`; only used for companies. */
  domain?: string;
  size?: "sm" | "md" | "lg";
}) {
  const initials =
    name
      .replace(/\(.*?\)/g, "")
      .split(/\s+/)
      .filter((w) => /^[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden border border-border bg-muted font-medium text-muted-foreground",
        kind === "company" ? "rounded-md" : "rounded-full",
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-[11px]",
        size === "lg" && "size-10 text-[13px]",
      )}
    >
      {initials}
      {kind === "company" && domain && (
        <LogoImg key={domain} domain={domain} className="absolute inset-0 size-full bg-white p-[12%]" />
      )}
    </span>
  );
}

/** Inline company glyph for references ("Acme" on a deal card, a person's
 *  employer): the logo when we have a domain, else the building icon. */
export function CompanyMark({ domain, className }: { domain?: string; className?: string }) {
  const [failedFor, setFailedFor] = useState("");
  const cls = cn("size-3 shrink-0", className);
  if (!domain || failedFor === domain) return <Building2 className={cls} aria-hidden />;
  return (
    <LogoImg
      key={domain}
      domain={domain}
      px={32}
      onFail={() => setFailedFor(domain)}
      className={cn(cls, "rounded-[3px] bg-white")}
    />
  );
}

function LogoImg({
  domain,
  px = 64,
  className,
  onFail,
}: {
  domain: string;
  px?: number;
  className?: string;
  onFail?: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const fail = () => {
    setHidden(true);
    onFail?.();
  };
  return (
    // A third-party favicon service; next/image would need it allow-listed.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl(domain, px)}
      alt=""
      aria-hidden
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn("object-contain", className)}
      onError={fail}
      // Unknown domains return a 16px placeholder globe — treat as no logo.
      onLoad={(e) => {
        if (e.currentTarget.naturalWidth <= 16) fail();
      }}
    />
  );
}

/** A toggle filter chip (relationship, pipeline, activity window…). `dashed`
 *  is the outline for an opt-in filter that isn't one of a set. */
export function Chip({
  active,
  dashed,
  onClick,
  children,
}: {
  active: boolean;
  dashed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 shrink-0 rounded-md border",
        dashed && "border-dashed",
        "border-border px-2 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        active && dashed && "border-solid",
        active && "border-foreground/40 bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="tap-target grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn("whitespace-nowrap border-b border-border px-2 py-2 font-medium", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        "whitespace-nowrap border-b border-border/60 px-2 py-2.5 align-middle",
        className,
      )}
    >
      {children}
    </td>
  );
}
