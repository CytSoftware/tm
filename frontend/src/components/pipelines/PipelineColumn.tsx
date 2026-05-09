"use client";

import { ReactNode, Ref } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Stage } from "@/lib/types";

type Props = {
  stage: Stage;
  count: number;
  children: ReactNode;
  onAdd?: () => void;
  bodyRef?: Ref<HTMLDivElement>;
  isDraggingOver?: boolean;
};

export function PipelineColumn({
  stage,
  count,
  children,
  onAdd,
  bodyRef,
  isDraggingOver,
}: Props) {
  return (
    <div className="flex-1 min-w-[240px] h-full flex flex-col min-h-0">
      <header className="shrink-0 flex items-center justify-between gap-2 px-1 py-1.5 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="size-1.5 rounded-full"
            style={{ background: stage.color }}
          />
          <span className="text-[13px] font-medium tracking-tight truncate">
            {stage.name}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {count}
          </span>
        </div>
        {onAdd && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            aria-label={`Add pipeline to ${stage.name}`}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </header>
      <div
        ref={bodyRef}
        className={cn(
          "scrollbar-none flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 rounded-md transition-colors",
          isDraggingOver && "bg-accent/40",
        )}
      >
        {children}
      </div>
    </div>
  );
}
