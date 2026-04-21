"use client";

import { ReactNode, Ref, useEffect, useRef } from "react";
import { Plus, Sparkles, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Column, Task } from "@/lib/types";

type Props = {
  column: Column;
  tasks: Task[];
  children: ReactNode;
  onAddTask?: () => void;
  /** Tinder-style backlog triage. Renders a button only when the column is
   *  named "Backlog" — parent passes the same handler to every column and
   *  this component decides whether to show it. */
  onDeclutter?: () => void;
  /** Tinder-style Todo-column assignment triage. Same render-gating pattern
   *  as ``onDeclutter`` — parent passes the handler to every column and the
   *  button only shows on Todo. */
  onAssign?: () => void;
  /** Ref on the scrollable body. Parent attaches a pragmatic-dnd drop
   *  target to it so drops into the empty space land in this column. */
  bodyRef?: Ref<HTMLDivElement>;
  isDraggingOver?: boolean;
  /** Infinite-scroll plumbing — when ``hasMore`` is true, a sentinel at the
   *  bottom of the list fires ``onLoadMore`` once it enters the viewport. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  /** Server-side total matching the column's current filters. Display this
   *  instead of ``tasks.length`` so users see the real count even before
   *  they scroll far enough to trigger further page fetches. */
  totalCount?: number;
};

export function KanbanColumn({
  column,
  tasks,
  children,
  onAddTask,
  onDeclutter,
  onAssign,
  bodyRef,
  isDraggingOver,
  hasMore,
  isLoadingMore,
  onLoadMore,
  totalCount,
}: Props) {
  const displayCount = totalCount ?? tasks.length;
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isLoadingMore) {
            onLoadMore();
          }
        }
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore]);

  return (
    <div className="flex-1 min-w-[200px] h-full flex flex-col min-h-0">
      <header className="shrink-0 flex items-center justify-between gap-2 px-1 py-1.5 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "size-1.5 rounded-full",
              column.is_done ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          <span className="text-[13px] font-medium tracking-tight truncate">
            {column.name}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {displayCount}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {onDeclutter && column.name === "Backlog" && tasks.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onDeclutter();
              }}
              aria-label="Declutter backlog"
              title="Declutter backlog"
            >
              <Sparkles className="size-3.5" />
            </Button>
          )}
          {onAssign && column.name === "Todo" && tasks.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onAssign();
              }}
              aria-label="Assign Todo tasks"
              title="Assign Todo tasks"
            >
              <UserPlus className="size-3.5" />
            </Button>
          )}
          {onAddTask && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onAddTask();
              }}
              aria-label={`Add task to ${column.name}`}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </div>
      </header>
      <div
        ref={bodyRef}
        className={cn(
          "scrollbar-none flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 rounded-md transition-colors",
          isDraggingOver && "bg-accent/40",
        )}
      >
        {children}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="shrink-0 py-2 text-center text-[11px] text-muted-foreground"
          >
            {isLoadingMore ? "Loading…" : " "}
          </div>
        )}
      </div>
    </div>
  );
}
