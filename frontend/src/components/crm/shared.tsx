"use client";

/** Small pieces every CRM view shares: pills, section headers, controls. */

import { Building2, User as UserIcon } from "lucide-react";

import type { EntityKind, Relationship } from "@/hooks/use-crm";
import { RELATIONSHIP_META } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

export const controlCls =
  "h-7 shrink-0 rounded-md border border-border bg-transparent px-1.5 text-[12px] text-foreground outline-none hover:bg-accent/50 focus-visible:border-ring disabled:opacity-50";

export const inputCls =
  "h-8 w-full min-w-0 rounded-md border border-border bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring";

export const ghostBtnCls =
  "tap-target inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";

export const outlineBtnCls =
  "tap-target inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";

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
 *  two read apart at a glance even in a dense list. */
export function ContactAvatar({
  name,
  kind,
  size = "md",
}: {
  name: string;
  kind: EntityKind;
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
        "grid shrink-0 place-items-center border border-border bg-muted font-medium text-muted-foreground",
        kind === "company" ? "rounded-md" : "rounded-full",
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-[11px]",
        size === "lg" && "size-10 text-[13px]",
      )}
    >
      {initials}
    </span>
  );
}
