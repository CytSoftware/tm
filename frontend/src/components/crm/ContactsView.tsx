"use client";

/**
 * People in the CRM — a dense, scannable table: who they are, and the last
 * update that concerned them. Filters live in the page's URL.
 */

import type { Contact } from "@/hooks/use-crm";
import { relativeDay, shortDate, updateKindMeta } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { ContactAvatar, Td, Th } from "./shared";

export function ContactsView({
  contacts,
  selectedId,
  onOpen,
}: {
  contacts: Contact[];
  selectedId: number | null;
  onOpen: (id: number) => void;
}) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[28rem] border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-[1] bg-background/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <Th className="pl-4">Name</Th>
            <Th className="pr-4">Last update</Th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => {
            const sub = [c.position, c.company?.name].filter(Boolean).join(" · ");
            return (
              <tr
                key={c.id}
                onClick={() => onOpen(c.id)}
                aria-selected={selectedId === c.id}
                className={cn(
                  "group cursor-pointer hover:bg-accent/40",
                  selectedId === c.id && "bg-accent/60",
                )}
              >
                {/* w-full + max-w-0: the name column absorbs the squeeze and
                    truncates, so dates never wrap when a pane is open. */}
                <Td className="w-full max-w-0 pl-4">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ContactAvatar name={c.name} kind={c.kind} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="truncate text-[12px] text-muted-foreground">{sub || "—"}</div>
                    </div>
                  </div>
                </Td>
                <Td className="pr-4">
                  <LastUpdate contact={c} />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LastUpdate({ contact: c }: { contact: Contact }) {
  const last = c.last_update;
  if (!last) return <span className="text-[12px] text-muted-foreground/70">never</span>;
  const Icon = updateKindMeta(last.kind).icon;
  return (
    <div className="w-52 min-w-0 max-lg:w-36">
      <div
        className="flex items-center gap-1 text-[12px] tabular-nums text-foreground/80"
        title={shortDate(last.at)}
      >
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        {relativeDay(last.at)}
      </div>
      <div className="truncate text-[12px] text-muted-foreground" title={last.body}>
        {last.body}
      </div>
    </div>
  );
}
