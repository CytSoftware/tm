"use client";

/**
 * /focus — the user's personal "My Focus" view.
 *
 * Two columns side-by-side: ``Today`` and ``This week``. Cards in each are
 * the same Kanban cards used everywhere else, so star toggles, click-to-edit,
 * priority badges all work without re-implementation. Drag a card from one
 * column to the other to promote/demote it; the position the card lands at
 * is persisted server-side via ``PATCH /api/me/focus/<key>/`` with the
 * before/after neighbour ids.
 */

import {
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { CalendarDays, Star } from "lucide-react";

import { KanbanCard } from "@/components/kanban/Card";
import {
  useFocusQuery,
  useUpdateFocus,
} from "@/hooks/use-focus";
import { useTaskDialog } from "@/lib/task-dialog";
import { cn } from "@/lib/utils";
import type { FocusItem, FocusPeriod } from "@/lib/types";

type DragData = {
  type: "focus-card";
  itemId: number;
  taskKey: string;
  fromPeriod: FocusPeriod;
};

function isDragData(d: Record<string, unknown>): d is DragData & Record<string, unknown> {
  return d.type === "focus-card";
}

const PERIOD_META: Record<
  FocusPeriod,
  { title: string; subtitle: string; icon: typeof Star; accent: string }
> = {
  day: {
    title: "Today",
    subtitle: "Items you plan to work on now",
    icon: CalendarDays,
    accent: "text-amber-500",
  },
  week: {
    title: "This week",
    subtitle: "The broader queue — promote into Today when it's time",
    icon: Star,
    accent: "text-blue-500",
  },
};

export default function FocusPage() {
  const focusQuery = useFocusQuery();
  const updateFocus = useUpdateFocus();
  const taskDialog = useTaskDialog();

  const items: FocusItem[] = useMemo(() => focusQuery.data ?? [], [focusQuery.data]);

  const today = useMemo(
    () => items.filter((i) => i.period === "day").sort(byPosition),
    [items],
  );
  const thisWeek = useMemo(
    () => items.filter((i) => i.period === "week").sort(byPosition),
    [items],
  );

  // Drop monitor for cross-column moves and reorders within a column.
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isDragData(source.data),
      onDrop: ({ source, location }) => {
        if (!isDragData(source.data)) return;
        const target = location.current.dropTargets[0];
        if (!target) return;

        const sourceItem = items.find((i) => i.id === source.data.itemId);
        if (!sourceItem) return;

        const td = target.data;
        if (isDragData(td)) {
          // Dropped onto another card — bisect against that card's position.
          const overItem = items.find((i) => i.id === td.itemId);
          if (!overItem || overItem.id === sourceItem.id) return;
          const edge = extractClosestEdge(td);
          const destPeriod = overItem.period;
          const sameBucket = items
            .filter((i) => i.period === destPeriod && i.id !== sourceItem.id)
            .sort(byPosition);
          const overIdx = sameBucket.findIndex((i) => i.id === overItem.id);
          if (overIdx === -1) return;
          const insertIdx = overIdx + (edge === "bottom" ? 1 : 0);
          const before = sameBucket[insertIdx];
          const after = sameBucket[insertIdx - 1];
          updateFocus.mutate({
            taskKey: sourceItem.task.key,
            period: destPeriod,
            before_id: before?.id ?? null,
            after_id: after?.id ?? null,
          });
          return;
        }
        if (isPeriodDrop(td)) {
          // Dropped onto an empty column area — append to the bottom.
          if (td.period === sourceItem.period) return;
          updateFocus.mutate({
            taskKey: sourceItem.task.key,
            period: td.period,
          });
        }
      },
    });
  }, [items, updateFocus]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-border/80 bg-background">
        <Star className="size-4 fill-amber-500 text-amber-500" />
        <h1 className="text-[13px] font-semibold tracking-tight">My Focus</h1>
        <span className="text-[11px] text-muted-foreground">
          Your personal priority queue. Drag between Today and This week to
          rebalance.
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden bg-muted/40">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full px-4 py-3">
          <FocusColumn
            period="day"
            items={today}
            onCardClick={(item) => taskDialog.openTask(item.task)}
            isLoading={focusQuery.isLoading}
          />
          <FocusColumn
            period="week"
            items={thisWeek}
            onCardClick={(item) => taskDialog.openTask(item.task)}
            isLoading={focusQuery.isLoading}
          />
        </div>
      </div>
    </div>
  );
}

function byPosition(a: FocusItem, b: FocusItem): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}

type PeriodDropData = { type: "focus-period"; period: FocusPeriod };

function isPeriodDrop(d: Record<string, unknown>): d is PeriodDropData & Record<string, unknown> {
  return d.type === "focus-period";
}

function FocusColumn({
  period,
  items,
  onCardClick,
  isLoading,
}: {
  period: FocusPeriod;
  items: FocusItem[];
  onCardClick: (item: FocusItem) => void;
  isLoading: boolean;
}) {
  const meta = PERIOD_META[period];
  const Icon = meta.icon;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isDragData(source.data),
      getData: (): PeriodDropData => ({ type: "focus-period", period }),
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [period]);

  return (
    <section
      className={cn(
        "flex flex-col min-h-0 rounded-xl border border-border/60 bg-card",
        "transition-colors",
        isOver && "border-primary/50 bg-primary/5",
      )}
    >
      <header className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-border/40">
        <Icon className={cn("size-4", meta.accent)} />
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-tight leading-tight">
            {meta.title}
          </h2>
          <p className="text-[11px] text-muted-foreground leading-tight">
            {meta.subtitle}
          </p>
        </div>
        <span className="ml-auto font-mono tabular-nums text-[11px] text-muted-foreground bg-muted/60 rounded px-2 py-0.5">
          {items.length}
        </span>
      </header>

      <div
        ref={bodyRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2"
      >
        {isLoading ? (
          <p className="text-[12px] text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState period={period} />
        ) : (
          items.map((item) => (
            <Fragment key={item.id}>
              <DraggableFocusCard item={item}>
                {({ isDragging }) => (
                  <KanbanCard
                    task={item.task}
                    isDragging={isDragging}
                    showProject
                    onClick={() => onCardClick(item)}
                  />
                )}
              </DraggableFocusCard>
            </Fragment>
          ))
        )}
      </div>
    </section>
  );
}

function DraggableFocusCard({
  item,
  children,
}: {
  item: FocusItem;
  children: (state: { isDragging: boolean }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: (): DragData => ({
          type: "focus-card",
          itemId: item.id,
          taskKey: item.task.key,
          fromPeriod: item.period,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          isDragData(source.data) && source.data.itemId !== item.id,
        getData: ({ input, element }) => {
          const data: DragData = {
            type: "focus-card",
            itemId: item.id,
            taskKey: item.task.key,
            fromPeriod: item.period,
          };
          return attachClosestEdge(data, {
            input,
            element,
            allowedEdges: ["top", "bottom"],
          });
        },
        getIsSticky: () => true,
      }),
    );
  }, [item.id, item.task.key, item.period]);

  return <div ref={ref}>{children({ isDragging })}</div>;
}

function EmptyState({ period }: { period: FocusPeriod }) {
  const isDay = period === "day";
  return (
    <div className="grid place-items-center py-12 px-4 text-center text-[12px] text-muted-foreground rounded-lg border border-dashed border-border/60">
      <div className="space-y-1">
        <p className="font-medium text-foreground/70">
          {isDay ? "Nothing planned for today." : "No focus items yet."}
        </p>
        <p>
          {isDay
            ? "Drag a card here from This week, or click the star on a task and choose Today."
            : "Click the star icon on any task card to pin it here."}
        </p>
      </div>
    </div>
  );
}
