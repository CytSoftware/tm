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

const PRIORITY_DOT: Record<Priority, string> = {
  URGENT: "bg-red-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-blue-500",
  LOW: "bg-muted-foreground/50",
};

const PRIORITY_LABEL: Record<Priority, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
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
  if (visibleFields == null) return true; // null/undefined = show all
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
        "group rounded-lg border bg-card p-2.5 text-[13px]",
        "cursor-grab active:cursor-grabbing select-none",
        "shadow-[0_1px_0_rgba(0,0,0,0.02)]",
        "transition-[background-color,border-color,box-shadow] duration-150",
        isDragging && "opacity-30",
        isSelected
          ? "border-foreground/40 bg-accent/40"
          : "border-border/80 hover:border-border hover:bg-accent/30",
        isOverlay &&
          "cursor-grabbing shadow-lg border-border ring-1 ring-border/40",
      )}
    >
      {/* Row 1: key + priority + icons */}
      {(showKey || showPriority || showProjectPrefix) && (
        <div className="flex items-center justify-between gap-1.5 mb-0.5">
          <div className="flex items-center gap-1.5 min-w-0">
            {showPriority && (
              <Tooltip>
                <TooltipTrigger>
                  <span
                    className={cn(
                      "size-1.5 rounded-full shrink-0",
                      PRIORITY_DOT[task.priority],
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {PRIORITY_LABEL[task.priority]}
                </TooltipContent>
              </Tooltip>
            )}
            {showKey && (
              <span className="font-mono text-[10px] text-muted-foreground tracking-wide">
                {task.key}
              </span>
            )}
            {showProjectPrefix && (
              <span className="text-[10px] text-muted-foreground/70 truncate">
                {task.project_prefix}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {task.is_recurring_instance && (
              <Tooltip>
                <TooltipTrigger>
                  <Repeat className="size-3 text-muted-foreground/70" />
                </TooltipTrigger>
                <TooltipContent>Recurring instance</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      )}

      {/* Row 2: title */}
      {showTitle && (
        <div className="font-medium text-[13px] leading-snug tracking-tight line-clamp-2 text-foreground">
          {task.title}
        </div>
      )}

      {/* Row 3: labels */}
      {showLabels && task.labels.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="text-[10px] px-1.5 py-[1px] rounded-full"
              style={{
                background: `${l.color}22`,
                color: l.color,
                border: `1px solid ${l.color}44`,
              }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      {/* Row 4: metadata footer */}
      {(showAssignee || showDueDate || showPoints) && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            {showAssignee && task.assignee && (
              <div className="flex items-center gap-1 min-w-0">
                <UserAvatar
                  username={task.assignee.username}
                  avatarUrl={task.assignee.avatar_url}
                  size="size-4"
                />
                <span className="truncate">{task.assignee.username}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {showDueDate && task.due_at && (
              <div className="flex items-center gap-0.5">
                <CalendarDays className="size-3" />
                <span>
                  {new Date(task.due_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            )}
            {showPoints && task.story_points != null && (
              <span className="font-mono tabular-nums">
                {task.story_points} pts
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
