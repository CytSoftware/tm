"use client";

import { MessageSquare } from "lucide-react";

import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import { withAlpha } from "@/lib/colors";
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

  return (
    <div
      onClick={(e) => {
        if (!isDragging) {
          e.stopPropagation();
          onClick?.();
        }
      }}
      className={cn(
        "group rounded-lg border bg-card text-[13px]",
        "cursor-grab active:cursor-grabbing select-none",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        "transition-[background-color,border-color,box-shadow] duration-150",
        isDragging && "shadow-lg ring-1 ring-border/40",
        isSelected
          ? "border-foreground/40 bg-accent/40"
          : "border-border/60 hover:border-border hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
        <span className="font-mono text-[10px] text-muted-foreground/80 tracking-wider uppercase truncate">
          {pipeline.key}
        </span>
      </div>

      <div
        className="px-3 pb-1.5 font-medium text-[13px] leading-[1.4] tracking-tight line-clamp-2 break-words text-foreground"
        title={pipeline.title}
      >
        {pipeline.title}
      </div>

      {pipeline.counterparty && (
        <div className="px-3 pb-1.5">
          <span
            className="text-[10px] font-medium px-1.5 py-[2px] rounded-md"
            style={{
              background: withAlpha(pipeline.stage.color, 0.12),
              color: pipeline.stage.color,
            }}
            title={`Counterparty: ${pipeline.counterparty}`}
          >
            {pipeline.counterparty}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border/40">
        <div className="flex items-center gap-1.5 min-w-0">
          {pipeline.owner ? (
            <div className="flex items-center gap-1.5">
              <UserAvatar
                username={pipeline.owner.username}
                avatarUrl={pipeline.owner.avatar_url}
                size="size-5"
              />
              <span className="text-[11px] text-muted-foreground truncate">
                {pipeline.owner.username}
              </span>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground/60">
              Unowned
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[11px] text-muted-foreground/70">
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
      </div>
    </div>
  );
}
