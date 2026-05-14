"use client";

import {
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PipelineCard } from "@/components/pipelines/PipelineCard";
import { PipelineColumn } from "@/components/pipelines/PipelineColumn";
import { PipelinePanel } from "@/components/pipelines/PipelinePanel";
import { CreatePipelineDialog } from "@/components/pipelines/CreatePipelineDialog";
import {
  EMPTY_PIPELINE_FILTERS,
  useMovePipeline,
  usePipelinesQuery,
  usePipelineStagesQuery,
  type PipelineFilters,
} from "@/hooks/use-pipelines";
import type { Pipeline, Stage } from "@/lib/types";
import { connectPipelineSocket } from "@/lib/pipelines-ws";

type CardDrag = {
  type: "pipeline-card";
  pipelineId: number;
  pipelineKey: string;
  stageId: number;
};

type StageDrop = {
  type: "pipeline-stage";
  stageId: number;
};

function isCardData(
  data: Record<string, unknown>,
): data is CardDrag & Record<string, unknown> {
  return data.type === "pipeline-card";
}

function isStageData(
  data: Record<string, unknown>,
): data is StageDrop & Record<string, unknown> {
  return data.type === "pipeline-stage";
}

function DraggableCard({
  pipeline,
  stageId,
  children,
}: {
  pipeline: Pipeline;
  stageId: number;
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
        getInitialData: (): CardDrag => ({
          type: "pipeline-card",
          pipelineId: pipeline.id,
          pipelineKey: pipeline.key,
          stageId,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          isCardData(source.data) && source.data.pipelineId !== pipeline.id,
        getData: ({ input, element }) => {
          const data: CardDrag = {
            type: "pipeline-card",
            pipelineId: pipeline.id,
            pipelineKey: pipeline.key,
            stageId,
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
  }, [pipeline.id, pipeline.key, stageId]);

  return <div ref={ref}>{children({ isDragging })}</div>;
}

function DroppableStage({
  stage,
  count,
  children,
}: {
  stage: Stage;
  count: number;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isCardData(source.data),
      getData: (): StageDrop => ({ type: "pipeline-stage", stageId: stage.id }),
      onDragEnter: () => setIsDraggingOver(true),
      onDragLeave: () => setIsDraggingOver(false),
      onDrop: () => setIsDraggingOver(false),
    });
  }, [stage.id]);

  return (
    <PipelineColumn
      stage={stage}
      count={count}
      bodyRef={bodyRef}
      isDraggingOver={isDraggingOver}
    >
      {children}
    </PipelineColumn>
  );
}

export default function PipelinesPage() {
  const queryClient = useQueryClient();
  const stagesQuery = usePipelineStagesQuery();
  const movePipeline = useMovePipeline();

  const [filters, setFilters] = useState<PipelineFilters>(() => ({
    ...EMPTY_PIPELINE_FILTERS,
  }));

  const pipelinesQuery = usePipelinesQuery(filters);

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // One global pipelines socket per page mount.
  useEffect(() => {
    return connectPipelineSocket({ queryClient });
  }, [queryClient]);

  // Memoize the array fallbacks so identity is stable across renders —
  // otherwise `stages = data ?? []` would create a fresh empty array each
  // render and invalidate downstream useMemo / useEffect dependencies that
  // close over it.
  const stages = useMemo(
    () => stagesQuery.data ?? [],
    [stagesQuery.data],
  );
  const allPipelines = useMemo(
    () => pipelinesQuery.data?.results ?? [],
    [pipelinesQuery.data],
  );

  // Group by stage in the order returned by the stages endpoint. We rely on
  // the server's ordering by stage__order/position so pre-grouping here is
  // just a single bucket pass.
  const pipelinesByStage = useMemo(() => {
    const out = new Map<number, Pipeline[]>();
    for (const s of stages) out.set(s.id, []);
    for (const p of allPipelines) {
      const list = out.get(p.stage.id);
      if (list) list.push(p);
    }
    return out;
  }, [stages, allPipelines]);

  const [dragPreview, setDragPreview] = useState<{
    sourcePipelineId: number;
    destStageId: number;
    insertIndex: number;
  } | null>(null);

  const draggedPipeline = useMemo(() => {
    if (!dragPreview) return null;
    return allPipelines.find((p) => p.id === dragPreview.sourcePipelineId) ?? null;
  }, [dragPreview, allPipelines]);

  // Drag monitor — same shape as the task board but simpler because there
  // are no virtual cross-board columns to translate.
  useEffect(() => {
    const resolveDrop = (
      sourceId: number,
      target: { data: Record<string, unknown> } | undefined,
    ): { destStageId: number; insertIndex: number } | null => {
      if (!target) return null;
      const data = target.data;
      if (isCardData(data)) {
        const dest = pipelinesByStage.get(data.stageId) ?? [];
        const filtered = dest.filter((p) => p.id !== sourceId);
        const overIdx = filtered.findIndex((p) => p.id === data.pipelineId);
        if (overIdx === -1) return null;
        const edge = extractClosestEdge(data);
        return {
          destStageId: data.stageId,
          insertIndex: overIdx + (edge === "bottom" ? 1 : 0),
        };
      }
      if (isStageData(data)) {
        const dest = pipelinesByStage.get(data.stageId) ?? [];
        const filtered = dest.filter((p) => p.id !== sourceId);
        return {
          destStageId: data.stageId,
          insertIndex: filtered.length,
        };
      }
      return null;
    };

    return monitorForElements({
      canMonitor: ({ source }) => isCardData(source.data),
      onDragStart: () => setDragPreview(null),
      onDrag: ({ source, location }) => {
        if (!isCardData(source.data)) return;
        const resolved = resolveDrop(
          source.data.pipelineId,
          location.current.dropTargets[0],
        );
        if (!resolved) {
          setDragPreview((prev) => (prev === null ? prev : null));
          return;
        }
        setDragPreview((prev) => {
          if (
            prev &&
            prev.sourcePipelineId === source.data.pipelineId &&
            prev.destStageId === resolved.destStageId &&
            prev.insertIndex === resolved.insertIndex
          ) {
            return prev;
          }
          return {
            sourcePipelineId: source.data.pipelineId as number,
            destStageId: resolved.destStageId,
            insertIndex: resolved.insertIndex,
          };
        });
      },
      onDrop: ({ source, location }) => {
        setDragPreview(null);
        if (!isCardData(source.data)) return;
        const resolved = resolveDrop(
          source.data.pipelineId,
          location.current.dropTargets[0],
        );
        if (!resolved) return;

        const moving = allPipelines.find(
          (p) => p.id === source.data.pipelineId,
        );
        if (!moving) return;

        const destStage = stages.find((s) => s.id === resolved.destStageId);
        if (!destStage) return;

        const destPipelines = (
          pipelinesByStage.get(resolved.destStageId) ?? []
        ).filter((p) => p.id !== moving.id);
        const insertIdx = resolved.insertIndex;
        const afterId =
          insertIdx > 0 ? destPipelines[insertIdx - 1]?.id : undefined;
        const beforeId =
          insertIdx < destPipelines.length
            ? destPipelines[insertIdx]?.id
            : undefined;

        const afterP = afterId
          ? destPipelines.find((p) => p.id === afterId)
          : undefined;
        const beforeP = beforeId
          ? destPipelines.find((p) => p.id === beforeId)
          : undefined;
        let estimated: number;
        if (afterP && beforeP) {
          estimated = (afterP.position + beforeP.position) / 2;
        } else if (afterP) {
          estimated = afterP.position + 1000;
        } else if (beforeP) {
          estimated = beforeP.position - 1000;
        } else {
          const tail = destPipelines.reduce(
            (m, p) => (p.position > m ? p.position : m),
            0,
          );
          estimated = tail + 1000;
        }

        movePipeline.mutate({
          key: moving.key,
          stage_id: destStage.id,
          before_id: beforeId ?? null,
          after_id: afterId ?? null,
          optimistic: { destStage, estimatedPosition: estimated },
        });
      },
    });
  }, [pipelinesByStage, stages, allPipelines, movePipeline]);

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-border/80 bg-background">
          <span className="text-[13px] font-medium">Pipelines</span>
          <span className="text-[11px] text-muted-foreground">
            {allPipelines.length}
          </span>
          <div className="h-5 w-px bg-border mx-0.5 shrink-0" />
          <div className="relative w-64 shrink-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              className="h-8 pl-7 text-[13px]"
              placeholder="Search pipelines…"
              value={filters.search}
              onChange={(e) =>
                setFilters({ ...filters, search: e.target.value })
              }
            />
          </div>
          <div className="flex-1" />
          <Button
            size="sm"
            className="h-8 text-[13px]"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            New pipeline
          </Button>
        </header>

        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden bg-muted/40">
          {stages.length === 0 ? (
            <div className="h-full grid place-items-center text-[13px] text-muted-foreground">
              Loading stages…
            </div>
          ) : (
            <div className="flex gap-3 h-full px-4 py-3">
              {stages.map((stage) => {
                const list = pipelinesByStage.get(stage.id) ?? [];
                const visible = dragPreview
                  ? list.filter(
                      (p) => p.id !== dragPreview.sourcePipelineId,
                    )
                  : list;
                const isDest = dragPreview?.destStageId === stage.id;
                const previewIdx = isDest ? dragPreview!.insertIndex : -1;

                const ghost = draggedPipeline ? (
                  <div
                    key="__preview"
                    className="pointer-events-none opacity-50 rounded-lg border-2 border-dashed border-primary/40"
                  >
                    <PipelineCard pipeline={draggedPipeline} />
                  </div>
                ) : null;

                return (
                  <DroppableStage
                    key={stage.id}
                    stage={stage}
                    count={list.length}
                  >
                    {visible.map((pipeline, idx) => (
                      <div key={pipeline.id}>
                        {isDest && idx === previewIdx && ghost}
                        <DraggableCard
                          pipeline={pipeline}
                          stageId={stage.id}
                        >
                          {({ isDragging }) => (
                            <PipelineCard
                              pipeline={pipeline}
                              isDragging={isDragging}
                              isSelected={pipeline.key === selectedKey}
                              onClick={() => setSelectedKey(pipeline.key)}
                            />
                          )}
                        </DraggableCard>
                      </div>
                    ))}
                    {isDest && previewIdx === visible.length && ghost}
                  </DroppableStage>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedKey && (
        <PipelinePanel
          pipelineKey={selectedKey}
          onClose={() => setSelectedKey(null)}
        />
      )}

      <CreatePipelineDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
