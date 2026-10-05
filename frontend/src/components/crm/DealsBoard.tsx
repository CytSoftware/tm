"use client";

/**
 * Deals kanban for one pipeline: a column per stage, value total per column.
 *
 * Drag uses `@atlaskit/pragmatic-drag-and-drop`, registered only under
 * `(pointer: fine)` — its element adapter is the native HTML5 drag API, which
 * never fires from touch. Touch gets long-press → a "Move to stage" sheet,
 * same as the task board (CLAUDE.md, responsive conventions).
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/UserAvatar";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useLongPress } from "@/hooks/use-long-press";
import { type Deal, type Pipeline, type Stage, useMoveDeal } from "@/hooks/use-crm";
import { companyDomain, errorMessage, formatMoney, shortDate } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { CompanyMark } from "./shared";

type DragData = { type: "crm-deal"; key: string; stageId: number };
type ColumnData = { type: "crm-stage"; stageId: number };

const isDeal = (d: Record<string, unknown>): d is DragData & Record<string, unknown> =>
  d.type === "crm-deal";
const isStage = (d: Record<string, unknown>): d is ColumnData & Record<string, unknown> =>
  d.type === "crm-stage";

export function DealsBoard({
  pipeline,
  deals,
  selectedKey,
  onOpen,
  onNewDeal,
}: {
  pipeline: Pipeline;
  deals: Deal[];
  selectedKey: string | null;
  onOpen: (key: string) => void;
  onNewDeal: (stageId: number) => void;
}) {
  const move = useMoveDeal(pipeline.id);
  const [touchMove, setTouchMove] = useState<Deal | null>(null);

  const byStage = useMemo(() => {
    const map = new Map<number, Deal[]>();
    for (const s of pipeline.stages) map.set(s.id, []);
    for (const d of deals) map.get(d.stage.id)?.push(d);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [pipeline.stages, deals]);

  const doMove = (deal: Deal, stageId: number, index?: number) =>
    move.mutate(
      { dealKey: deal.key, stage: stageId, index },
      { onError: (e) => toast.error(errorMessage(e)) },
    );

  // One monitor resolves every drop: onto a card (before/after it) or onto
  // a column's empty space (to the bottom).
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isDeal(source.data),
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target || !isDeal(source.data)) return;
        const deal = deals.find((d) => d.key === source.data.key);
        if (!deal) return;
        const td = target.data;
        if (isDeal(td)) {
          if (td.key === deal.key) return;
          const siblings = (byStage.get(td.stageId) ?? []).filter((d) => d.key !== deal.key);
          const at = siblings.findIndex((d) => d.key === td.key);
          const edge = extractClosestEdge(td);
          doMove(deal, td.stageId, edge === "bottom" ? at + 1 : at);
        } else if (isStage(td)) {
          if (td.stageId === deal.stage.id) return;
          doMove(deal, td.stageId);
        }
      },
    });
    // doMove is stable enough per render; deals/byStage are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, byStage]);

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-4 pb-4 pt-3">
      {pipeline.stages.map((stage) => (
        <StageColumn
          key={stage.id}
          stage={stage}
          deals={byStage.get(stage.id) ?? []}
          selectedKey={selectedKey}
          onOpen={onOpen}
          onNewDeal={() => onNewDeal(stage.id)}
          onLongPress={setTouchMove}
        />
      ))}

      <Sheet open={touchMove != null} onOpenChange={(o) => !o && setTouchMove(null)}>
        <SheetContent side="bottom" className="lg:hidden">
          <SheetHeader>
            <SheetTitle className="truncate">Move {touchMove?.key}</SheetTitle>
            <p className="truncate text-[12px] text-muted-foreground">{touchMove?.title}</p>
          </SheetHeader>
          <SheetBody className="px-2 pb-2">
            {pipeline.stages.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  if (touchMove && s.id !== touchMove.stage.id) doMove(touchMove, s.id);
                  setTouchMove(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[14px] active:bg-accent"
              >
                <span className="flex-1">{s.name}</span>
                {touchMove?.stage.id === s.id && <Check className="size-4 text-muted-foreground" />}
              </button>
            ))}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StageColumn({
  stage,
  deals,
  selectedKey,
  onOpen,
  onNewDeal,
  onLongPress,
}: {
  stage: Stage;
  deals: Deal[];
  selectedKey: string | null;
  onOpen: (key: string) => void;
  onNewDeal: () => void;
  onLongPress: (deal: Deal) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isDeal(source.data),
      getData: (): ColumnData => ({ type: "crm-stage", stageId: stage.id }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, [stage.id]);

  const total = deals.reduce((n, d) => n + (d.value ? Number(d.value) : 0), 0);
  const currency = deals.find((d) => d.value)?.currency ?? "QAR";

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full min-h-0 w-72 shrink-0 flex-col rounded-lg bg-muted/40 max-lg:w-[80vw]",
        over && "ring-1 ring-foreground/20",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            stage.kind === "won"
              ? "bg-emerald-500"
              : stage.kind === "lost"
                ? "bg-muted-foreground/40"
                : "bg-sky-500",
          )}
        />
        <h3 className="truncate text-[12px] font-medium">{stage.name}</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{deals.length}</span>
        {total > 0 && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {formatMoney(String(total), currency)}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
        {deals.map((d) => (
          <DealCard
            key={d.key}
            deal={d}
            selected={selectedKey === d.key}
            onOpen={onOpen}
            onLongPress={onLongPress}
          />
        ))}
        <button
          type="button"
          onClick={onNewDeal}
          className="tap-target flex h-7 w-full items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground opacity-60 hover:bg-background/70 hover:opacity-100 hover-none:opacity-100"
        >
          <Plus className="size-3.5" /> New deal
        </button>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  selected,
  onOpen,
  onLongPress,
}: {
  deal: Deal;
  selected: boolean;
  onOpen: (key: string) => void;
  onLongPress: (deal: Deal) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<"top" | "bottom" | null>(null);
  const longPress = useLongPress(() => onLongPress(deal));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const data: DragData = { type: "crm-deal", key: deal.key, stageId: deal.stage.id };
    return combine(
      draggable({
        element: el,
        getInitialData: () => data,
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => isDeal(source.data) && source.data.key !== deal.key,
        getData: ({ input, element }) =>
          attachClosestEdge(data, { input, element, allowedEdges: ["top", "bottom"] }),
        onDrag: ({ self }) => setEdge(extractClosestEdge(self.data) as "top" | "bottom" | null),
        onDragLeave: () => setEdge(null),
        onDrop: () => setEdge(null),
        getIsSticky: () => true,
      }),
    );
  }, [deal.key, deal.stage.id]);

  return (
    <div
      ref={ref}
      {...longPress}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(deal.key)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(deal.key)}
      className={cn(
        "relative cursor-pointer rounded-md border border-border bg-background px-2.5 py-2 shadow-xs hover:border-foreground/25",
        selected && "border-foreground/40 ring-1 ring-foreground/15",
        dragging && "opacity-40",
      )}
    >
      {edge && (
        <span
          className={cn(
            "absolute inset-x-1 h-0.5 rounded bg-sky-500",
            edge === "top" ? "-top-1" : "-bottom-1",
          )}
        />
      )}
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] leading-snug">{deal.title}</span>
        {deal.owner && (
          <UserAvatar username={deal.owner.username} avatarUrl={deal.owner.avatar_url} size="size-4" />
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {deal.company && (
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <CompanyMark domain={companyDomain(deal.company.website)} />
            <span className="truncate">{deal.company.name}</span>
          </span>
        )}
        {deal.value && (
          <span className="ml-auto shrink-0 tabular-nums">{formatMoney(deal.value, deal.currency)}</span>
        )}
      </div>
      {(deal.product_project || deal.expected_close) && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
          {deal.product_project && (
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: deal.product_project.color }} />
              {deal.product_project.name}
            </span>
          )}
          {deal.expected_close && (
            <span className="ml-auto">close {shortDate(deal.expected_close)}</span>
          )}
        </div>
      )}
    </div>
  );
}
