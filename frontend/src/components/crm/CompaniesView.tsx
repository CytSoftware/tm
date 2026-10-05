"use client";

/**
 * Companies in the CRM, with what rolls up to them: how many people we know
 * there, what's open in the pipeline (count + value), and the company-wide
 * last activity / next step (which already include their people's).
 * The detail pane is the same contact pane — for a company it lists people,
 * deals and the combined timeline.
 */

import { UserAvatar } from "@/components/UserAvatar";
import type { Contact } from "@/hooks/use-crm";
import { formatMoney, isOverdue, relativeDay, shortDate } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { ContactAvatar, RelationshipPill } from "./shared";

export function CompaniesView({
  companies,
  selectedId,
  onOpen,
  compact,
}: {
  companies: Contact[];
  selectedId: number | null;
  onOpen: (id: number) => void;
  /** A detail pane is open: drop the columns the pane already shows, so the
   *  company name keeps room to read. */
  compact?: boolean;
}) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-[1] bg-background/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <Th className="pl-4">Company</Th>
            <Th>Type</Th>
            <Th className="text-right">People</Th>
            <Th className="text-right">Open deals</Th>
            {!compact && <Th>Last activity</Th>}
            <Th className={cn(compact && "pr-4")}>Next step</Th>
            {!compact && <Th className="pr-4 text-right">Owner</Th>}
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
                  <ContactAvatar name={c.name} kind="company" />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {c.headline || c.website.replace(/^https?:\/\/(www\.)?/, "") || "—"}
                    </div>
                  </div>
                </div>
              </Td>
              <Td>
                <RelationshipPill relationship={c.relationship} />
              </Td>
              <Td className="text-right tabular-nums text-muted-foreground">
                {c.people_count || "—"}
              </Td>
              <Td className="text-right tabular-nums">
                {c.open_deal_count ? (
                  <div>
                    <div>{c.open_deal_count}</div>
                    {c.open_deal_value && Number(c.open_deal_value) > 0 && (
                      <div className="text-[12px] text-muted-foreground">
                        {formatMoney(c.open_deal_value)}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Td>
              {!compact && (
              <Td>
                {c.last_activity ? (
                  <div className="w-40 min-w-0 max-lg:w-28">
                    <div
                      className="text-[12px] tabular-nums text-foreground/80"
                      title={shortDate(c.last_activity.at)}
                    >
                      {relativeDay(c.last_activity.at)}
                    </div>
                    <div className="truncate text-[12px] text-muted-foreground" title={c.last_activity.text}>
                      {c.last_activity.text}
                    </div>
                  </div>
                ) : (
                  <span className="text-[12px] text-muted-foreground/70">never</span>
                )}
              </Td>
              )}
              <Td className={cn(compact && "pr-4")}>
                {c.next_follow_up_at ? (
                  <div className="w-40 min-w-0 max-lg:w-28">
                    <div
                      className={cn(
                        "text-[12px] tabular-nums",
                        isOverdue(c.next_follow_up_at) ? "text-destructive" : "text-foreground/80",
                      )}
                    >
                      {relativeDay(c.next_follow_up_at)}
                    </div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {c.next_follow_up_title}
                    </div>
                  </div>
                ) : (
                  <span
                    className={cn(
                      "text-[12px]",
                      c.has_open_follow_up
                        ? "text-muted-foreground"
                        : "text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {c.has_open_follow_up ? "undated" : "no next step"}
                  </span>
                )}
              </Td>
              {!compact && (
              <Td className="pr-4">
                <div className="flex justify-end">
                  {c.owner ? (
                    <UserAvatar username={c.owner.username} avatarUrl={c.owner.avatar_url} size="size-5" />
                  ) : (
                    <span className="text-[12px] text-muted-foreground/60">—</span>
                  )}
                </div>
              </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn("whitespace-nowrap border-b border-border px-2 py-2 font-medium", className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
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
