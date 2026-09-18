"use client";

/**
 * Swimlane timeline: one lane per group (company, person, category, project),
 * time running left → right, one dot per meeting. It answers the question the
 * list can't — *when* did we talk to whom, and where are the gaps.
 *
 * Plain positioned elements inside a natively scrolling box: horizontal scroll,
 * momentum and touch all come for free, and the lane labels stay put with
 * `position: sticky`.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  startOfMonth,
} from "date-fns";
import { useTheme } from "next-themes";

import type { MeetingSummary } from "@/hooks/use-meetings";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryColor,
} from "@/lib/meeting-meta";
import { cn } from "@/lib/utils";

import type { ListGroupBy } from "./MeetingList";

const LABEL_W = 148;
const DOT = 12;
const ROW_PAD = 10;
const STACK_STEP = DOT + 3;

type Lane = { key: string; label: string; meetings: MeetingSummary[] };

function buildLanes(meetings: MeetingSummary[], by: ListGroupBy): Lane[] {
  const lanes = new Map<string, Lane>();
  const add = (key: string, label: string, m: MeetingSummary) => {
    const lane = lanes.get(key);
    if (lane) lane.meetings.push(m);
    else lanes.set(key, { key, label, meetings: [m] });
  };
  for (const m of meetings) {
    if (by === "category" || by === "month") {
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
      if (!hits.length)
        add("~", by === "company" ? "No company" : "No people", m);
      for (const e of hits) add(`e${e.id}`, e.name, m);
    }
  }
  const list = [...lanes.values()];
  if (by === "category" || by === "month") {
    const order = (k: string) => CATEGORY_ORDER.indexOf(k as never);
    return list.sort((a, b) => order(a.key) - order(b.key));
  }
  return list.sort(
    (a, b) =>
      Number(a.key === "~") - Number(b.key === "~") ||
      b.meetings.length - a.meetings.length ||
      a.label.localeCompare(b.label),
  );
}

export function MeetingTimeline({
  meetings,
  groupBy,
  selectedKey,
  onOpen,
}: {
  meetings: MeetingSummary[];
  groupBy: ListGroupBy;
  selectedKey: string | null;
  onOpen: (key: string) => void;
}) {
  const dark = useTheme().resolvedTheme === "dark";
  const scroller = useRef<HTMLDivElement>(null);

  const model = useMemo(() => {
    const times = meetings.map((m) => new Date(m.started_at).getTime());
    const start = startOfMonth(new Date(Math.min(...times)));
    const end = endOfMonth(new Date(Math.max(...times)));
    const days = differenceInCalendarDays(end, start) + 1;
    const pxPerDay = days <= 92 ? 14 : days <= 366 ? 7 : 4;
    const months: { label: string; x: number; w: number; year: boolean }[] = [];
    for (let d = start; d <= end; d = addMonths(d, 1)) {
      const x = differenceInCalendarDays(d, start) * pxPerDay;
      const w = (differenceInCalendarDays(endOfMonth(d), d) + 1) * pxPerDay;
      const year = d.getMonth() === 0 || months.length === 0;
      months.push({ label: format(d, year ? "MMM yyyy" : "MMM"), x, w, year });
    }
    const lanes = buildLanes(meetings, groupBy).map((lane) => {
      // Same-day meetings in one lane stack upward instead of overlapping.
      const perDay = new Map<number, number>();
      const dots = lane.meetings.map((m) => {
        const day = differenceInCalendarDays(new Date(m.started_at), start);
        const slot = perDay.get(day) ?? 0;
        perDay.set(day, slot + 1);
        return { m, x: day * pxPerDay + pxPerDay / 2, slot };
      });
      const stack = Math.max(1, ...perDay.values());
      return {
        ...lane,
        dots,
        height: ROW_PAD * 2 + DOT + (stack - 1) * STACK_STEP,
      };
    });
    return { width: days * pxPerDay, months, lanes };
  }, [meetings, groupBy]);

  // Open on the most recent end — that's where the eye wants to start.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [model.width]);

  return (
    <div ref={scroller} className="h-full min-h-0 min-w-0 overflow-auto">
      <div className="relative" style={{ width: LABEL_W + model.width }}>
        {/* Month header */}
        <div className="sticky top-0 z-20 flex h-8 border-b border-border bg-background">
          <div
            className="sticky left-0 z-10 shrink-0 border-r border-border bg-background"
            style={{ width: LABEL_W }}
          />
          <div className="relative flex-1">
            {model.months.map((mo) => (
              <div
                key={mo.x}
                className={cn(
                  "absolute inset-y-0 flex items-center border-l border-border/70 pl-1.5 text-[11px] text-muted-foreground",
                  mo.year && "font-medium text-foreground/80",
                )}
                style={{ left: mo.x, width: mo.w }}
              >
                <span className="truncate">{mo.label}</span>
              </div>
            ))}
          </div>
        </div>

        {model.lanes.map((lane) => (
          <div
            key={lane.key}
            className="flex border-b border-border/60"
            style={{ height: lane.height }}
          >
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-border bg-background px-3 text-[12px]"
              style={{ width: LABEL_W }}
            >
              <span className="truncate">{lane.label}</span>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">
                {lane.meetings.length}
              </span>
            </div>
            <div className="relative flex-1">
              {model.months.map((mo) => (
                <div
                  key={mo.x}
                  className="absolute inset-y-0 border-l border-border/40"
                  style={{ left: mo.x }}
                />
              ))}
              {lane.dots.map(({ m, x, slot }) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => onOpen(m.key)}
                  title={`${m.title} — ${format(new Date(m.started_at), "EEE d MMM yyyy, HH:mm")}`}
                  aria-label={`${m.title}, ${format(new Date(m.started_at), "d MMM yyyy")}`}
                  className={cn(
                    // Not `tap-target`: that utility sets `position: relative`, which
                    // would un-anchor the dot. Same idea, inline.
                    "absolute rounded-full after:absolute after:-inset-3 after:content-[''] ring-2 ring-background transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none",
                    m.key === selectedKey && "scale-125 ring-ring",
                  )}
                  style={{
                    width: DOT,
                    height: DOT,
                    left: x - DOT / 2,
                    bottom: ROW_PAD + slot * STACK_STEP,
                    background: categoryColor(m.category, dark),
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
