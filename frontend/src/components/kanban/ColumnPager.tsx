"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { Column } from "@/lib/types";

type ColumnPagerProps = {
  columns: Column[];
  /** Loaded task count per column id — mirrors each column header's badge. */
  counts: Map<number, number>;
  /** The board's `overflow-x-auto` element. Passed as a resolved node rather
   *  than a ref so this re-subscribes when the track mounts — it isn't in the
   *  DOM yet on the first render, while projects are still loading. */
  scroller: HTMLElement | null;
};

/**
 * Mobile column switcher (TAS-061).
 *
 * Below `lg` the board track becomes a scroll-snap pager — one full-width
 * column per page (see `KanbanColumn`'s `max-lg:w-dvw max-lg:snap-start`).
 * Swiping is therefore plain native scrolling: no gesture library, and no
 * conflict with tapping a card or scrolling a column vertically.
 *
 * This strip is the overview that a pager otherwise loses — which columns
 * exist, how full they are, and where you are. It both reports the scroll
 * position and drives it.
 */
export function ColumnPager({ columns, counts, scroller }: ColumnPagerProps) {
  const [active, setActive] = useState(0);
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Derive the active page from scroll position. Every column is exactly one
  // viewport wide with no gap or track padding at this breakpoint, so the
  // page index is a plain division — no IntersectionObserver needed.
  useEffect(() => {
    const el = scroller;
    if (!el) return;
    // One division and a setState that bails on an unchanged value — cheap
    // enough to run per scroll event without rAF throttling.
    const onScroll = () => {
      const width = el.clientWidth || 1;
      setActive(
        Math.max(
          0,
          Math.min(columns.length - 1, Math.round(el.scrollLeft / width)),
        ),
      );
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scroller, columns.length]);

  // Keep the active pill on screen when the board is swiped rather than tapped.
  useEffect(() => {
    pillRefs.current[active]?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [active]);

  function goTo(index: number) {
    const el = scroller;
    if (!el) return;
    el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
    setActive(index);
  }

  if (columns.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Board columns"
      className="lg:hidden shrink-0 flex items-center gap-1 overflow-x-auto scrollbar-none border-b border-border/80 bg-background px-2 py-1.5"
    >
      {columns.map((col, i) => {
        const count = counts.get(col.id);
        const isActive = i === active;
        return (
          <button
            key={col.id}
            ref={(node) => {
              pillRefs.current[i] = node;
            }}
            role="tab"
            aria-selected={isActive}
            onClick={() => goTo(i)}
            className={cn(
              "shrink-0 tap-target inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap transition-colors",
              isActive
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                col.is_done
                  ? "bg-emerald-500"
                  : isActive
                    ? "bg-background/50"
                    : "bg-muted-foreground/40",
              )}
            />
            {col.name}
            {count != null && (
              <span
                className={cn(
                  "tabular-nums",
                  isActive ? "text-background/70" : "text-muted-foreground/70",
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
