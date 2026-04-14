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
import { TimeInColumn } from "@/components/task/TimeInColumn";
import { cn } from "@/lib/utils";
import { withAlpha } from "@/lib/colors";
import type { Task, Priority, CardField, User } from "@/lib/types";

const PRIORITY_BADGE: Record<
  Priority,
  { bg: string; text: string; border: string; label: string }
> = {
  P1: {
    bg: "bg-red-500/10",
    text: "text-red-600 dark:text-red-400",
    border: "border-red-500/30",
    label: "P1",
  },
  P2: {
    bg: "bg-orange-500/10",
    text: "text-orange-600 dark:text-orange-400",
    border: "border-orange-500/30",
    label: "P2",
  },
  P3: {
    bg: "bg-blue-500/10",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-blue-500/30",
    label: "P3",
  },
  P4: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
    label: "P4",
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
  const showProjectPill =
    showProject && isVisible("project", visibleFields);

  const pri = task.priority ? PRIORITY_BADGE[task.priority] : null;

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
            <span className="font-mono text-[10px] text-muted-foreground/80 tracking-wider uppercase truncate">
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
          {showPriority && pri && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border font-semibold font-mono tracking-wider",
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

      {/* Title — wraps on word boundaries, clamps at 3 lines, hover shows full. */}
      {showTitle && (
        <div
          className="px-3 pb-1.5 font-medium text-[13px] leading-[1.4] tracking-tight line-clamp-3 break-words text-foreground"
          title={task.title}
        >
          {task.title}
        </div>
      )}

      {/* Project pill — prominent colored badge, replaces the muted footer text.
          Hidden entirely for projectless tasks (ProjectPill returns null). */}
      {showProjectPill && task.project_prefix && (
        <div className="px-3 pb-1.5">
          <ProjectPill task={task} />
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
                background: withAlpha(l.color, 0.12),
                color: l.color,
              }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      {/* Footer: assignees + time-in-column + due date */}
      {((showAssignee && task.assignees.length > 0) ||
        (showDueDate && task.due_at) ||
        task.current_column_since) && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border/40">
          <div className="flex items-center gap-1.5 min-w-0">
            {showAssignee && task.assignees.length > 0 && (
              <AssigneeStack users={task.assignees} />
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 text-[11px] text-muted-foreground/70">
            <TimeInColumn task={task} durationOnly />
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

function ProjectPill({ task }: { task: Task }) {
  // Projectless (Inbox) tasks don't render a pill at all — the Kanban's
  // "Inbox" column already makes the grouping obvious, and a "No project"
  // badge adds visual noise without conveying new information.
  if (!task.project_name && !task.project_prefix) return null;
  const color = task.project_color ?? "#6366f1";
  const label = task.project_name ?? task.project_prefix ?? "";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold border max-w-full min-w-0"
      style={{
        background: withAlpha(color, 0.14),
        color,
        borderColor: withAlpha(color, 0.35),
      }}
      title={label}
    >
      <span
        className="size-1.5 rounded-full shrink-0"
        style={{ background: color }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Stacked avatars with a `+N` overflow bubble. */
function AssigneeStack({ users }: { users: User[] }) {
  const VISIBLE = 3;
  const shown = users.slice(0, VISIBLE);
  const extra = users.length - shown.length;
  const singleName = users.length === 1 ? users[0].username : null;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div className="flex items-center -space-x-1.5">
        {shown.map((u) => (
          <Tooltip key={u.id}>
            <TooltipTrigger
              render={
                <div className="ring-2 ring-card rounded-full">
                  <UserAvatar
                    username={u.username}
                    avatarUrl={u.avatar_url}
                    size="size-5"
                  />
                </div>
              }
            />
            <TooltipContent>{u.username}</TooltipContent>
          </Tooltip>
        ))}
        {extra > 0 && (
          <div className="size-5 ring-2 ring-card rounded-full bg-muted text-[9px] font-semibold text-muted-foreground grid place-items-center">
            +{extra}
          </div>
        )}
      </div>
      {singleName && (
        <span className="text-[11px] text-muted-foreground truncate">
          {singleName}
        </span>
      )}
    </div>
  );
}
