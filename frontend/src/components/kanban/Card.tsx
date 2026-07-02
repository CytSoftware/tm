"use client";

import { CalendarDays, Repeat, UserPlus } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { TimeInColumn } from "@/components/task/TimeInColumn";
import {
  AssigneeCheckboxList,
  LabelCheckboxList,
  PriorityMenu,
} from "@/components/task/pickers";
import { LinkedPRBadge } from "@/components/integrations/LinkedPRBadge";
import { useUpdateTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { useLabelsQuery } from "@/hooks/use-labels";
import { cn } from "@/lib/utils";
import { withAlpha } from "@/lib/colors";
import { PRIORITY_DOT } from "@/lib/types";
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

  // Inline chip editors (priority / assignees / labels) — reuse the same
  // mutation + shared checkbox-list pickers as the task panel (see
  // components/task/pickers.tsx), but PATCH immediately on each toggle
  // instead of waiting for a form submit. `useUsersQuery`/`useLabelsQuery`
  // share the same query keys the board page already fetches, so this is a
  // cache hit, not an extra request, in the common case.
  const updateTask = useUpdateTask();
  const usersQuery = useUsersQuery();
  const allUsers = usersQuery.data ?? [];
  const labelsQuery = useLabelsQuery();
  // Labels selectable for this task: global labels plus ones scoped to the
  // task's own project — mirrors the scope rule the backend enforces in
  // TaskUpdateSerializer. `task.project` is present even on the
  // all-projects board, so this resolves correctly there too.
  const availableLabels = (labelsQuery.data ?? []).filter(
    (l) => l.project == null || l.project === task.project,
  );

  function handlePriorityChange(next: Priority | null) {
    if (next === task.priority) return;
    updateTask.mutate({ key: task.key, priority: next });
  }

  function handleAssigneeToggle(id: number) {
    const current = task.assignees.map((u) => u.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    updateTask.mutate({
      key: task.key,
      assignee_ids: next,
      optimisticAssignees: allUsers.filter((u) => next.includes(u.id)),
    });
  }

  function handleLabelToggle(id: number) {
    const current = task.labels.map((l) => l.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    updateTask.mutate({
      key: task.key,
      label_ids: next,
      optimisticLabels: availableLabels.filter((l) => next.includes(l.id)),
    });
  }

  // The footer row also hosts the hover-reveal placeholder chips (ghost
  // priority dot / ghost assignee avatar) that make the empty priority and
  // assignee fields reachable — see AssigneeStack and the priority Popover
  // below. So the row has to stay mounted whenever either field is enabled
  // for this view, even with no data to show, not just when it "has content"
  // like the other optional rows.
  const hasFooter =
    showKey ||
    task.is_recurring_instance ||
    showPriority ||
    showAssignee ||
    (showPoints && task.story_points != null) ||
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

      {/* Labels — click opens the same label picker as the task panel. */}
      {showLabels && task.labels.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label="Edit labels"
                className="w-full px-3 pb-1.5 flex flex-wrap gap-1 text-left rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
              >
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
              </button>
            }
          />
          <PopoverContent className="w-56 p-1" align="start">
            <LabelCheckboxList
              available={availableLabels}
              selected={task.labels.map((l) => l.id)}
              onToggle={handleLabelToggle}
            />
          </PopoverContent>
        </Popover>
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
          empty (unless priority/assignee hover placeholders keep it around —
          see `hasFooter` above). */}
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
          {showPriority && (
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    title={pri && task.priority ? `Priority ${pri.label}` : "Set priority"}
                    className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                  >
                    {pri && task.priority ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-mono text-[10px] font-semibold tracking-wider",
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
                    ) : (
                      // Hover-reveal placeholder — keeps "no priority" tasks
                      // reachable without cluttering the default view.
                      <span
                        aria-hidden
                        className="block size-2.5 rounded-full border border-dashed border-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    )}
                  </button>
                }
              />
              <PopoverContent className="w-36 p-1" align="start">
                <PriorityMenu
                  value={task.priority}
                  onSelect={handlePriorityChange}
                />
              </PopoverContent>
            </Popover>
          )}
          {showPoints && task.story_points != null && (
            <span className="font-mono tabular-nums bg-muted/60 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground shrink-0">
              {task.story_points}
            </span>
          )}
          <div className="flex-1" />
          {showAssignee && (
            <AssigneeStack
              task={task}
              allUsers={allUsers}
              onToggle={handleAssigneeToggle}
            />
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

/** Stacked avatars with a `+N` overflow bubble. Click opens the same
 *  assignee picker as the task panel; an empty stack shows a hover-reveal
 *  ghost avatar so the field stays reachable. */
function AssigneeStack({
  task,
  allUsers,
  onToggle,
}: {
  task: Task;
  allUsers: User[];
  onToggle: (id: number) => void;
}) {
  const VISIBLE = 3;
  const users = task.assignees;
  const shown = users.slice(0, VISIBLE);
  const extra = users.length - shown.length;
  const singleName = users.length === 1 ? users[0].username : null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label="Edit assignees"
            className="flex items-center gap-1.5 min-w-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            {users.length === 0 ? (
              <span className="size-5 rounded-full border border-dashed border-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity grid place-items-center">
                <UserPlus className="size-2.5 text-muted-foreground/60" />
              </span>
            ) : (
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
            )}
            {singleName && (
              <span className="text-[11px] text-muted-foreground truncate">
                {singleName}
              </span>
            )}
          </button>
        }
      />
      <PopoverContent className="w-52 p-1" align="end">
        <AssigneeCheckboxList
          available={allUsers}
          selected={users.map((u) => u.id)}
          onToggle={onToggle}
        />
      </PopoverContent>
    </Popover>
  );
}
