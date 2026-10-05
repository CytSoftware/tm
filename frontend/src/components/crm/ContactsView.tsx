"use client";

/**
 * People and companies in the CRM — a dense, scannable table. Each row
 * answers the three questions you open a CRM for: who is this, what happened
 * last, and what do we owe them next. Filters live in the page's URL.
 */

import { AudioLines } from "lucide-react";

import { UserAvatar } from "@/components/UserAvatar";
import type { Contact } from "@/hooks/use-crm";
import { TOUCHPOINT_META, isOverdue, relativeDay, shortDate } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { ContactAvatar, RelationshipPill } from "./shared";

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
      <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-[1] bg-background/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <Th className="pl-4">Name</Th>
            <Th>Type</Th>
            <Th>Last activity</Th>
            <Th>Next step</Th>
            <Th className="pr-4 text-right">Owner</Th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => {
            const overdue = isOverdue(c.next_follow_up_at);
            const sub = [c.headline, c.company?.name]
              .filter(Boolean)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(" · ");
            const act = c.last_activity;
            const ActIcon =
              act?.type === "touchpoint" ? TOUCHPOINT_META[act.kind]?.icon : AudioLines;
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
                      <div className="truncate text-[12px] text-muted-foreground">
                        {sub || (c.kind === "company" ? "Company" : "Person")}
                      </div>
                    </div>
                  </div>
                </Td>
                <Td>
                  <RelationshipPill relationship={c.relationship} />
                </Td>
                <Td>
                  {act ? (
                    <div className="w-44 min-w-0 max-lg:w-32">
                      <div
                        className="flex items-center gap-1 text-[12px] tabular-nums text-foreground/80"
                        title={shortDate(act.at)}
                      >
                        {ActIcon && <ActIcon className="size-3 shrink-0 text-muted-foreground" />}
                        {relativeDay(act.at)}
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground" title={act.text}>
                        {act.text}
                      </div>
                    </div>
                  ) : (
                    <span className="text-[12px] text-muted-foreground/70">never</span>
                  )}
                </Td>
                <Td>
                  {c.next_follow_up_at ? (
                    <div className="w-48 min-w-0 max-lg:w-36">
                      <div
                        className={cn(
                          "text-[12px] tabular-nums",
                          overdue ? "text-destructive" : "text-foreground/80",
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
                <Td className="pr-4">
                  <div className="flex justify-end">
                    {c.owner ? (
                      <UserAvatar
                        username={c.owner.username}
                        avatarUrl={c.owner.avatar_url}
                        size="size-5"
                      />
                    ) : (
                      <span className="text-[12px] text-muted-foreground/60">—</span>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
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
