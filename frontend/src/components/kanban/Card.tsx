"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays, Repeat } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import type { Task, Priority, CardField } from "@/lib/types";

const PRIORITY_BADGE: Record<
  Priority,
  { bg: string; text: string; border: string; label: string }
> = {
  URGENT: {
    bg: "bg-red-500/10",
    text: "text-red-600 dark:text-red-400",
    border: "border-red-500/20",
    label: "Urgent",
  },
  HIGH: {
    bg: "bg-orange-500/10",
    text: "text-orange-600 dark:text-orange-400",
    border: "border-orange-500/20",
    label: "High",
  },
  MEDIUM: {
    bg: "bg-blue-500/10",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-blue-500/20",
    label: "Medium",
  },
  LOW: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
    label: "Low",
  },
};

type Props = {
  task: Task;
  onClick?: () => void;
  isOverlay?: boolean;
  isSelected?: boolean;
  showProject?: boolean;
  visibleFields?: CardField[] | null;
};

function isVisible(
  field: CardField,
  visibleFields: CardField[] | null | undefined,
): boolean {
  if (visibleFields == null) return true;
  return visibleFields.includes(field);
}

export function KanbanCard({
  task,
  onClick,
  isOverlay,
  isSelected,
  showProject,
  visibleFields,
}: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const showKey = isVisible("key", visibleFields);
  const showTitle = isVisible("title", visibleFields);
  const showPriority = isVisible("priority", visibleFields);
  const showAssignee = isVisible("assignee", visibleFields);
  const showLabels = isVisible("labels", visibleFields);
  const showPoints = isVisible("points", visibleFields);
  const showDueDate = isVisible("due_date", visibleFields);
  const showProjectPrefix =
    showProject && isVisible("project", visibleFields);

  const pri = PRIORITY_BADGE[task.priority];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
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
        isDragging && "opacity-30",
        isSelected
          ? "border-foreground/40 bg-accent/40"
          : "border-border/60 hover:border-border hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]",
        isOverlay &&
          "cursor-grabbing shadow-xl border-border ring-1 ring-border/40",
      )}
    >
      {/* Header: key + priority badge */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {showKey && (
            <span className="font-mono text-[10px] text-muted-foreground/80 tracking-wider uppercase">
              {task.key}
            </span>
          )}
          {task.is_recurring_instance && (
            <Tooltip>
              <TooltipTrigger>
                <Repeat className="size-3 text-muted-foreground/50" />
              </TooltipTrigger>
              <TooltipContent>Recurring instance</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {showPoints && task.story_points != null && (
            <span className="font-mono tabular-nums bg-muted/60 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground">
              {task.story_points}
            </span>
          )}
          {showPriority && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border font-medium",
                pri.bg,
                pri.text,
                pri.border,
              )}
            >
              {pri.label}
            </span>
          )}
        </div>
      </div>

      {/* Title */}
      {showTitle && (
        <div className="px-3 pb-1.5 font-medium text-[13px] leading-[1.4] tracking-tight line-clamp-2 text-foreground">
          {task.title}
        </div>
      )}

      {/* Labels */}
      {showLabels && task.labels.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="text-[10px] font-medium px-1.5 py-[2px] rounded-md"
              style={{
                background: `${l.color}18`,
                color: l.color,
              }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      {/* Footer: assignee + due date */}
      {((showAssignee && task.assignee) ||
        (showDueDate && task.due_at) ||
        showProjectPrefix) && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border/40">
          <div className="flex items-center gap-1.5 min-w-0">
            {showAssignee && task.assignee && (
              <div className="flex items-center gap-1.5 min-w-0">
                <UserAvatar
                  username={task.assignee.username}
                  avatarUrl={task.assignee.avatar_url}
                  size="size-5"
                />
                <span className="text-[11px] text-muted-foreground truncate">
                  {task.assignee.username}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 text-[11px] text-muted-foreground/70">
            {showProjectPrefix && (
              <span className="text-[10px] text-muted-foreground/50 truncate max-w-24">
                {task.project_name ?? task.project_prefix}
              </span>
            )}
            {showDueDate && task.due_at && (
              <div className="flex items-center gap-1">
                <CalendarDays className="size-3" />
                <span>
                  {new Date(task.due_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
