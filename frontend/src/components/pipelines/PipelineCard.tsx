"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLogPipelineEvent } from "@/hooks/use-pipelines";
import type { Pipeline } from "@/lib/types";

type Props = {
  pipeline: Pipeline;
  onClick?: () => void;
  isDragging?: boolean;
  isSelected?: boolean;
};

export function PipelineCard({
  pipeline,
  onClick,
  isDragging,
  isSelected,
}: Props) {
  const lastEvent = pipeline.last_event_at
    ? new Date(pipeline.last_event_at)
    : null;
  const lastBody = (pipeline.last_event_body ?? "").trim();

  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const logEvent = useLogPipelineEvent();

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  function reset() {
    setDraft("");
    setComposing(false);
  }

  function submit() {
    const body = draft.trim();
    if (!body) {
      reset();
      return;
    }
    logEvent.mutate(
      { key: pipeline.key, body },
      {
        onSuccess: () => {
          setDraft("");
          inputRef.current?.focus();
        },
      },
    );
  }

  return (
    <div
      onClick={(e) => {
        if (composing) return;
        if (!isDragging) {
          e.stopPropagation();
          onClick?.();
        }
      }}
      className={cn(
        "group rounded-lg border bg-card text-[13px]",
        !composing && "cursor-grab active:cursor-grabbing",
        "select-none",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        "transition-[background-color,border-color,box-shadow] duration-150",
        isDragging && "shadow-lg ring-1 ring-border/40",
        isSelected
          ? "border-foreground/40 bg-accent/40"
          : "border-border/60 hover:border-border hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]",
      )}
    >
      <div className="px-3 pt-2 pb-2 space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-muted-foreground/70 tracking-wider uppercase truncate">
            {pipeline.key}
          </span>
          {(pipeline.event_count > 0 || lastEvent) && (
            <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted-foreground/70">
              {pipeline.event_count > 0 && (
                <div className="flex items-center gap-0.5" title="Timeline events">
                  <MessageSquare className="size-3" />
                  <span>{pipeline.event_count}</span>
                </div>
              )}
              {lastEvent && (
                <span title={`Last event: ${lastEvent.toLocaleString()}`}>
                  {lastEvent.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}
            </div>
          )}
        </div>
        <div
          className="font-medium text-[13px] leading-[1.4] tracking-tight line-clamp-2 break-words text-foreground"
          title={pipeline.title}
        >
          {pipeline.title}
        </div>
        {pipeline.counterparty && (
          <div
            className="text-[11px] text-muted-foreground truncate"
            title={`Counterparty: ${pipeline.counterparty}`}
          >
            {pipeline.counterparty}
          </div>
        )}
        {lastBody && (
          <div
            className="pt-1 text-[11px] text-muted-foreground/90 line-clamp-2 break-words"
            title={lastBody}
          >
            <span className="text-muted-foreground/50">›&nbsp;</span>
            {lastBody}
          </div>
        )}
      </div>

      {composing ? (
        <div
          className="border-t border-border/50 px-3 py-2"
          onClick={(e) => e.stopPropagation()}
          // Suppress drag while typing.
          draggable={false}
          onPointerDown={(e) => e.stopPropagation()}
        >
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
              if (logEvent.isPending) return;
              if (!draft.trim()) reset();
            }}
            placeholder="Log a timeline entry…"
            className="w-full bg-transparent outline-none text-[12px] placeholder:text-muted-foreground/60"
            disabled={logEvent.isPending}
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground/60">
            <span>Enter to log · Esc to close</span>
            {logEvent.isPending && <span>Logging…</span>}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setComposing(true);
          }}
          className={cn(
            "w-full flex items-center gap-1 px-3 py-1.5",
            "border-t border-border/40",
            "text-[10px] text-muted-foreground/60 hover:text-foreground hover:bg-accent/40",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            "cursor-text",
          )}
          aria-label="Log a timeline entry"
        >
          <Plus className="size-3" />
          Log entry
        </button>
      )}
    </div>
  );
}
