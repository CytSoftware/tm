"use client";

import { ReactNode, Ref, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCreatePipeline } from "@/hooks/use-pipelines";
import type { Stage } from "@/lib/types";

type Props = {
  stage: Stage;
  count: number;
  children: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  isDraggingOver?: boolean;
};

export function PipelineColumn({
  stage,
  count,
  children,
  bodyRef,
  isDraggingOver,
}: Props) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const createPipeline = useCreatePipeline();

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  function reset() {
    setDraft("");
    setComposing(false);
  }

  function submit() {
    const title = draft.trim();
    if (!title) {
      reset();
      return;
    }
    createPipeline.mutate(
      { title, stage_id: stage.id },
      {
        onSuccess: () => {
          setDraft("");
          // Keep composer open for rapid entry.
          inputRef.current?.focus();
        },
      },
    );
  }

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
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setComposing(true);
          }}
          aria-label={`Add pipeline to ${stage.name}`}
        >
          <Plus className="size-3.5" />
        </Button>
      </header>
      <div
        ref={bodyRef}
        className={cn(
          "scrollbar-none flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 rounded-md transition-colors",
          isDraggingOver && "bg-accent/40",
        )}
      >
        {composing && (
          <div className="rounded-lg border border-border/80 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] px-2.5 py-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  reset();
                }
              }}
              onBlur={() => {
                if (createPipeline.isPending) return;
                if (!draft.trim()) reset();
              }}
              placeholder="Pipeline title…"
              className="w-full bg-transparent outline-none text-[13px] font-medium tracking-tight placeholder:text-muted-foreground/60"
              disabled={createPipeline.isPending}
            />
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground/70">
              <span>Enter to add · Esc to close</span>
              {createPipeline.isPending && <span>Adding…</span>}
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
