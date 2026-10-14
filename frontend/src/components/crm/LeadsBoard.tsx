"use client";

/**
 * Leads kanban: a column per fixed stage. Each card
 * answers "what's next" (the soonest open task its updates filed) and "when
 * did we last hear" (its newest update).
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
import { Check, CircleDashed, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useLongPress } from "@/hooks/use-long-press";
import { type Lead, type LeadStage, useMoveLead } from "@/hooks/use-crm";
import {
  STAGES,
  companyDomain,
  errorMessage,
  isOverdue,
  relativeDay,
} from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import { CompanyMark } from "./shared";

type DragData = { type: "crm-lead"; key: string; stage: LeadStage };
type ColumnData = { type: "crm-stage"; stage: LeadStage };

const isLead = (d: Record<string, unknown>): d is DragData & Record<string, unknown> =>
  d.type === "crm-lead";
const isStage = (d: Record<string, unknown>): d is ColumnData & Record<string, unknown> =>
  d.type === "crm-stage";

export function LeadsBoard({
  leads,
  selectedKey,
  project = "",
  onOpen,
  onNewLead,
}: {
  leads: Lead[];
  selectedKey: string | null;
  /** Project prefix scope — part of the cache key the optimistic move edits. */
  project?: string;
  onOpen: (key: string) => void;
  onNewLead: (stage: LeadStage) => void;
}) {
  const move = useMoveLead(project);
  const [touchMove, setTouchMove] = useState<Lead | null>(null);

  const byStage = useMemo(() => {
    const map = new Map<LeadStage, Lead[]>(STAGES.map((s) => [s.id, []]));
    for (const l of leads) map.get(l.stage)?.push(l);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [leads]);

  const doMove = (lead: Lead, stage: LeadStage, index?: number) =>
    move.mutate(
      { leadKey: lead.key, stage, index },
      { onError: (e) => toast.error(errorMessage(e)) },
    );

  // One monitor resolves every drop: onto a card (before/after it) or onto
  // a column's empty space (to the bottom).
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isLead(source.data),
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target || !isLead(source.data)) return;
        const lead = leads.find((l) => l.key === source.data.key);
        if (!lead) return;
        const td = target.data;
        if (isLead(td)) {
          if (td.key === lead.key) return;
          const siblings = (byStage.get(td.stage) ?? []).filter((l) => l.key !== lead.key);
          const at = siblings.findIndex((l) => l.key === td.key);
          const edge = extractClosestEdge(td);
          doMove(lead, td.stage, edge === "bottom" ? at + 1 : at);
        } else if (isStage(td)) {
          if (td.stage === lead.stage) return;
          doMove(lead, td.stage);
        }
      },
    });
    // doMove is stable enough per render; leads/byStage are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, byStage]);

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-4 pb-4 pt-3">
      {STAGES.map((stage) => (
        <StageColumn
          key={stage.id}
          stage={stage}
          leads={byStage.get(stage.id) ?? []}
          selectedKey={selectedKey}
          onOpen={onOpen}
          onNewLead={() => onNewLead(stage.id)}
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
            {STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  if (touchMove && s.id !== touchMove.stage) doMove(touchMove, s.id);
                  setTouchMove(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[14px] active:bg-accent"
              >
                <span className="flex-1">{s.label}</span>
                {touchMove?.stage === s.id && <Check className="size-4 text-muted-foreground" />}
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
  leads,
  selectedKey,
  onOpen,
  onNewLead,
  onLongPress,
}: {
  stage: (typeof STAGES)[number];
  leads: Lead[];
  selectedKey: string | null;
  onOpen: (key: string) => void;
  onNewLead: () => void;
  onLongPress: (lead: Lead) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isLead(source.data),
      getData: (): ColumnData => ({ type: "crm-stage", stage: stage.id }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, [stage.id]);

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full min-h-0 w-72 shrink-0 flex-col rounded-lg bg-muted/40 max-lg:w-[80vw]",
        over && "ring-1 ring-foreground/20",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span className={cn("size-2 shrink-0 rounded-full", stage.dot)} />
        <h3 className="truncate text-[12px] font-medium">{stage.label}</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{leads.length}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
        {leads.map((l) => (
          <LeadCard
            key={l.key}
            lead={l}
            selected={selectedKey === l.key}
            onOpen={onOpen}
            onLongPress={onLongPress}
          />
        ))}
        <button
          type="button"
          onClick={onNewLead}
          className="tap-target flex h-7 w-full items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground opacity-60 hover:bg-background/70 hover:opacity-100 hover-none:opacity-100"
        >
          <Plus className="size-3.5" /> New lead
        </button>
      </div>
    </div>
  );
}

function LeadCard({
  lead,
  selected,
  onOpen,
  onLongPress,
}: {
  lead: Lead;
  selected: boolean;
  onOpen: (key: string) => void;
  onLongPress: (lead: Lead) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<"top" | "bottom" | null>(null);
  const longPress = useLongPress(() => onLongPress(lead));
  const closed = lead.stage === "won" || lead.stage === "lost";
  const step = lead.next_step;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const data: DragData = { type: "crm-lead", key: lead.key, stage: lead.stage };
    return combine(
      draggable({
        element: el,
        getInitialData: () => data,
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => isLead(source.data) && source.data.key !== lead.key,
        getData: ({ input, element }) =>
          attachClosestEdge(data, { input, element, allowedEdges: ["top", "bottom"] }),
        onDrag: ({ self }) => setEdge(extractClosestEdge(self.data) as "top" | "bottom" | null),
        onDragLeave: () => setEdge(null),
        onDrop: () => setEdge(null),
        getIsSticky: () => true,
      }),
    );
  }, [lead.key, lead.stage]);

  return (
    <div
      ref={ref}
      {...longPress}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(lead.key)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(lead.key)}
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
      <div className="text-[13px] leading-snug">{lead.title}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {lead.company && (
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <CompanyMark domain={companyDomain(lead.company.website)} />
            <span className="truncate">{lead.company.name}</span>
          </span>
        )}
      </div>
      {!closed && (
        <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-[11px]">
          <CircleDashed className="size-3 shrink-0 text-muted-foreground" />
          {step ? (
            <>
              <span className="min-w-0 flex-1 truncate">{step.title}</span>
              {step.due_at && (
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    isOverdue(step.due_at) ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {relativeDay(step.due_at)}
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">No next step</span>
          )}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
        {lead.project && (
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: lead.project.color }} />
            {lead.project.name}
          </span>
        )}
        <span className="ml-auto">
          {lead.last_update_at ? `updated ${relativeDay(lead.last_update_at)}` : "no updates"}
        </span>
      </div>
    </div>
  );
}
