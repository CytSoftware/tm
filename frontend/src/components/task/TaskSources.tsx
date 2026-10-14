"use client";

/** Where a task came from — the CRM lead whose update filed it, or the
 *  meeting whose action item it tracks — as small chips that link back. */

import { AudioLines, Handshake } from "lucide-react";

import type { TaskSource } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TaskSources({ sources, className }: { sources: TaskSource[]; className?: string }) {
  if (!sources?.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {sources.map((s) => {
        const lead = s.kind === "lead";
        const Icon = lead ? Handshake : AudioLines;
        const label = lead && s.company ? `${s.company} · ${s.title}` : s.title;
        return (
          <a
            key={`${s.kind}-${s.key}`}
            href={lead ? `/crm?l=${s.key}` : `/meetings?m=${s.key}`}
            onClick={(e) => e.stopPropagation()}
            title={`${lead ? "From lead" : "From meeting"} ${s.key}: ${s.title}`}
            className="inline-flex h-5 max-w-full items-center gap-1 rounded border border-border bg-muted/40 px-1.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
          </a>
        );
      })}
    </div>
  );
}
