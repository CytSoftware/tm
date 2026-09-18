"use client";

/**
 * Grouped list of meetings. Grouping is done client-side over the already
 * filtered set, so switching "group by" is instant and never refetches.
 *
 * A meeting can sit in several company/person groups (a call with two
 * companies belongs under both) — that's intended, it's how you'd look for it.
 */

import { useMemo } from "react";
import { format } from "date-fns";

import type { MeetingSummary } from "@/hooks/use-meetings";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/meeting-meta";

import { MeetingRow } from "./MeetingRow";

export type ListGroupBy =
  "month" | "company" | "person" | "category" | "project";

type Group = { key: string; label: string; meetings: MeetingSummary[] };

function groupMeetings(meetings: MeetingSummary[], by: ListGroupBy): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, m: MeetingSummary) => {
    const g = groups.get(key);
    if (g) g.meetings.push(m);
    else groups.set(key, { key, label, meetings: [m] });
  };

  for (const m of meetings) {
    if (by === "month") {
      const d = new Date(m.started_at);
      add(format(d, "yyyy-MM"), format(d, "MMMM yyyy"), m);
    } else if (by === "category") {
      add(m.category, CATEGORY_META[m.category]?.label ?? m.category, m);
    } else if (by === "project") {
      add(
        m.project ? `p${m.project.id}` : "~",
        m.project?.name ?? "No project",
        m,
      );
    } else {
      const kind = by === "company" ? "company" : "person";
      const hits = m.entities.filter(
        (e) => e.kind === kind && e.role === "attendee",
      );
      if (hits.length === 0)
        add("~", by === "company" ? "No company" : "No people", m);
      for (const e of hits) add(`e${e.id}`, e.name, m);
    }
  }

  const list = [...groups.values()];
  if (by === "month") return list.sort((a, b) => b.key.localeCompare(a.key));
  if (by === "category") {
    const order = (k: string) => CATEGORY_ORDER.indexOf(k as never);
    return list.sort((a, b) => order(a.key) - order(b.key));
  }
  // Busiest first, the "none" bucket always last.
  return list.sort(
    (a, b) =>
      Number(a.key === "~") - Number(b.key === "~") ||
      b.meetings.length - a.meetings.length ||
      a.label.localeCompare(b.label),
  );
}

export function MeetingList({
  meetings,
  groupBy,
  selectedKey,
  searchTerm,
  onOpen,
  onSelectEntity,
}: {
  meetings: MeetingSummary[];
  groupBy: ListGroupBy;
  selectedKey: string | null;
  searchTerm?: string;
  onOpen: (key: string) => void;
  onSelectEntity: (id: number) => void;
}) {
  const groups = useMemo(
    () => groupMeetings(meetings, groupBy),
    [meetings, groupBy],
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {groups.map((g) => (
        <section key={g.key}>
          <h2 className="sticky top-0 z-[1] flex items-baseline gap-2 border-b border-border/60 bg-background/95 px-4 py-1.5 text-[12px] font-medium backdrop-blur">
            {g.label}
            <span className="text-[11px] font-normal tabular-nums text-muted-foreground/70">
              {g.meetings.length}
            </span>
          </h2>
          {g.meetings.map((m) => (
            <MeetingRow
              key={`${g.key}:${m.key}`}
              meeting={m}
              selected={m.key === selectedKey}
              dateFormat={groupBy === "month" ? "EEE d" : "d MMM yy"}
              searchTerm={searchTerm}
              onOpen={onOpen}
              onSelectEntity={onSelectEntity}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
