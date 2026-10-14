"use client";

/**
 * Companies in the CRM, with what rolls up to them: how many people we know
 * there, open leads, and the newest update on them or their people. The
 * detail pane is the same contact pane — for a company it lists people,
 * leads and the combined thread.
 */

import type { Contact } from "@/hooks/use-crm";
import { companyDomain } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { LastUpdate } from "./ContactsView";
import { ContactAvatar, Td, Th } from "./shared";

export function CompaniesView({
  companies,
  selectedId,
  onOpen,
  compact,
}: {
  companies: Contact[];
  selectedId: number | null;
  onOpen: (id: number) => void;
  /** A detail pane is open: drop the roll-up columns so the name keeps room. */
  compact?: boolean;
}) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[28rem] border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-[1] bg-background/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <Th className="pl-4">Company</Th>
            {!compact && <Th className="text-right">People</Th>}
            {!compact && <Th className="text-right">Open leads</Th>}
            <Th className="pr-4">Last update</Th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c) => (
            <tr
              key={c.id}
              onClick={() => onOpen(c.id)}
              aria-selected={selectedId === c.id}
              className={cn(
                "cursor-pointer hover:bg-accent/40",
                selectedId === c.id && "bg-accent/60",
              )}
            >
              <Td className="w-full max-w-0 pl-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <ContactAvatar name={c.name} kind="company" domain={companyDomain(c.website, c.emails)} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") || "—"}
                    </div>
                  </div>
                </div>
              </Td>
              {!compact && (
                <Td className="text-right tabular-nums text-muted-foreground">{c.people_count || "—"}</Td>
              )}
              {!compact && (
                <Td className="text-right tabular-nums">
                  {c.open_lead_count || <span className="text-muted-foreground">—</span>}
                </Td>
              )}
              <Td className="pr-4">
                <LastUpdate contact={c} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
