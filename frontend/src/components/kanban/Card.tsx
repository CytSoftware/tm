"use client";

import { CalendarDays, Repeat } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/UserAvatar";
import { TimeInColumn } from "@/components/task/TimeInColumn";
import { LinkedPRBadge } from "@/components/integrations/LinkedPRBadge";
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

// Solid dot color per priority — used in the compact footer where a bordered
// badge would be too heavy. Mirrors PRIORITY_BADGE's semantic palette.
const PRIORITY_DOT: Record<Priority, string> = {
  P1: "bg-red-500",
  P2: "bg-orange-500",
  P3: "bg-blue-500",
  P4: "bg-muted-foreground/40",
};

type Props = {
  task: Task;
  onClick?: () => void;
  isOverlay?: boolean;
  isDragging?: boolean;
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
  isDragging,
  isSelected,
  showProject,
  visibleFields,
}: Props) {
  const showKey = isVisible("key", visibleFields);
  const showTitle = isVisible("title", visibleFields);
  const showPriority = isVisible("priority", visibleFields);
  const showAssignee = isVisible("assignee", visibleFields);
  const showLabels = isVisible("labels", visibleFields);
  const showPoints = isVisible("points", visibleFields);
  const showDueDate = isVisible("due_date", visibleFields);
  const showProjectPill =
    showProject && isVisible("project", visibleFields);
  const showLinkedPRs =
    isVisible("linked_pr", visibleFields) && task.linked_prs?.length > 0;

  const pri = task.priority ? PRIORITY_BADGE[task.priority] : null;

  const hasFooter =
    showKey ||
    task.is_recurring_instance ||
    (showPriority && pri != null) ||
    (showPoints && task.story_points != null) ||
    (showAssignee && task.assignees.length > 0) ||
    task.current_column_since != null;

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
        isOverlay &&
          "cursor-grabbing shadow-xl border-border ring-1 ring-border/40",
      )}
    >
      {/* Title — the visual anchor. Clamps at 2 lines on word boundaries with
          a clean ellipsis; full text on hover. */}
      <div className="relative px-3 pt-2.5 pb-1.5">
        {showTitle && (
          <div
            className="font-medium text-[13px] leading-[1.4] tracking-tight line-clamp-2 break-words text-foreground"
            title={task.title}
          >
            {task.title}
          </div>
        )}
      </div>

      {/* Optional rows — each appears only when it carries data, so cards with
          no metadata stay tight (no empty regions). */}

      {/* Linked PRs — chips link out to GitHub. State color encodes open /
          merged / closed / draft without needing the user to hover. */}
      {showLinkedPRs && (
        <div className="px-3 pb-1.5 flex flex-wrap gap-1">
          {task.linked_prs.map((pr) => (
            <LinkedPRBadge key={pr.id} pr={pr} />
          ))}
        </div>
      )}

      {/* Labels */}
      {showLabels && task.labels.length > 0 && (
        <div className="px-3 pb-1.5 flex flex-wrap gap-1">
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

      {/* Project pill — prominent colored badge. Hidden entirely for
          projectless tasks (ProjectPill returns null). */}
      {showProjectPill && task.project_prefix && (
        <div className="px-3 pb-1.5">
          <ProjectPill task={task} />
        </div>
      )}

      {/* Due date — its own row with overdue/soon/future tone, so a deadline
          reads at a glance instead of hiding in the footer. */}
      {showDueDate && task.due_at && <DueBadge due={task.due_at} />}

      {/* Single metadata footer: key · priority · points · assignees · time.
          Each item collapses out individually; the row hides entirely when
          empty. */}
      {hasFooter && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/50 text-[11px] text-muted-foreground">
          {showKey && (
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground/80 truncate">
              {task.key}
            </span>
          )}
          {task.is_recurring_instance && (
            <Tooltip>
              <TooltipTrigger
                render={<Repeat className="size-3 text-muted-foreground/50 shrink-0" />}
              />
              <TooltipContent>Recurring instance</TooltipContent>
            </Tooltip>
          )}
          {showPriority && pri && task.priority && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 font-mono text-[10px] font-semibold tracking-wider shrink-0",
                      pri.text,
                    )}
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        PRIORITY_DOT[task.priority],
                      )}
                    />
                    {pri.label}
                  </span>
                }
              />
              <TooltipContent>Priority {pri.label}</TooltipContent>
            </Tooltip>
          )}
          {showPoints && task.story_points != null && (
            <span className="font-mono tabular-nums bg-muted/60 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground shrink-0">
              {task.story_points}
            </span>
          )}
          <div className="flex-1" />
          {showAssignee && task.assignees.length > 0 && (
            <AssigneeStack users={task.assignees} />
          )}
          {task.current_column_since && (
            <span className="shrink-0 text-muted-foreground/70">
              <TimeInColumn task={task} durationOnly />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** overdue (red) / soon ≤2d (amber) / future (muted) tone for a due date.
 *  Time math lives in this plain helper (not the component body) to keep the
 *  component pure — same pattern as ``formatDuration``. */
function dueTone(due: string): string {
  const diffDays = Math.ceil((new Date(due).getTime() - Date.now()) / 86_400_000);
  if (diffDays < 0) return "text-red-600 dark:text-red-400";
  if (diffDays <= 2) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/** Due-date chip with overdue / soon / future tone. */
function DueBadge({ due }: { due: string }) {
  return (
    <div className={cn("px-3 pb-1.5 flex items-center gap-1 text-[11px]", dueTone(due))}>
      <CalendarDays className="size-3 shrink-0" />
      <span>
        {new Date(due).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })}
      </span>
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
