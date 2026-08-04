"use client";

import { useState } from "react";
import { CalendarDays, Check, Repeat, Target, UserPlus } from "lucide-react";

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
import { LinkedPRBadge } from "@/components/integrations/LinkedPRBadge";
import { useBetsQuery } from "@/hooks/use-bets";
import { useUpdateTask } from "@/hooks/use-tasks";
import { cn } from "@/lib/utils";
import { withAlpha } from "@/lib/colors";
import { currentPeriodStart } from "@/lib/periods";
import { PRIORITY_DOT, PRIORITY_TEXT } from "@/lib/types";
import type { Bet, BetRef, Task, Priority, CardField, User } from "@/lib/types";

const PRIORITY_BADGE: Record<
  Priority,
  { bg: string; text: string; border: string; label: string }
> = {
  P1: {
    bg: "bg-red-500/10",
    text: PRIORITY_TEXT.P1,
    border: "border-red-500/30",
    label: "P1",
  },
  P2: {
    bg: "bg-orange-500/10",
    text: PRIORITY_TEXT.P2,
    border: "border-orange-500/30",
    label: "P2",
  },
  P3: {
    bg: "bg-blue-500/10",
    text: PRIORITY_TEXT.P3,
    border: "border-blue-500/30",
    label: "P3",
  },
  P4: {
    bg: "bg-muted",
    text: PRIORITY_TEXT.P4,
    border: "border-border",
    label: "P4",
  },
};

/** Which property palette a chip click should open — see `PropertyPalette`
 *  (components/board/PropertyPalette.tsx), which the board renders centered
 *  over the whole page. The board also forces one open on `p`/`a`/`l` for
 *  the selected card (see board/page.tsx). */
export type EditorKind = "priority" | "assignee" | "labels";

type Props = {
  task: Task;
  onClick?: () => void;
  isOverlay?: boolean;
  isDragging?: boolean;
  isSelected?: boolean;
  showProject?: boolean;
  visibleFields?: CardField[] | null;
  /** Whether manual reorder applies. Done columns sort by recency (see
   *  `column.is_done`), so their cards drop the grab-cursor affordance —
   *  the card stays draggable (to move it out of Done) but no longer
   *  invites reordering. Defaults to true. */
  sortable?: boolean;
  /** Chip click → ask the board to select this card and open the matching
   *  PropertyPalette (priority/assignee/labels) — see
   *  `handleEditorOpenRequest` in board/page.tsx. The board owns rendering
   *  the palette; this card just reports which chip was clicked. Cards
   *  rendered outside the board's selection model (drag ghost) omit it,
   *  leaving the chips inert. */
  onEditorOpenRequest?: (kind: EditorKind) => void;
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
  sortable = true,
  onEditorOpenRequest,
}: Props) {
  const showKey = isVisible("key", visibleFields);
  const showTitle = isVisible("title", visibleFields);
  const showPriority = isVisible("priority", visibleFields);
  const showAssignee = isVisible("assignee", visibleFields);
  const showLabels = isVisible("labels", visibleFields);
  const showBet = isVisible("bet", visibleFields);
  const showPoints = isVisible("points", visibleFields);
  const showDueDate = isVisible("due_date", visibleFields);
  const showProjectPill =
    showProject && isVisible("project", visibleFields);
  const showLinkedPRs =
    isVisible("linked_pr", visibleFields) && task.linked_prs?.length > 0;
  const showReviewer =
    isVisible("reviewer", visibleFields) && task.reviewer != null;

  const pri = task.priority ? PRIORITY_BADGE[task.priority] : null;

  // Only the bet chip still mutates from this component — priority/assignee/
  // labels are edited through PropertyPalette (components/board/
  // PropertyPalette.tsx), which the board renders when a chip is clicked
  // (see onEditorOpenRequest below).
  const updateTask = useUpdateTask();

  function handleBetSelect(bet: BetRef | null) {
    if ((bet?.id ?? null) === (task.bet?.id ?? null)) return;
    updateTask.mutate({
      key: task.key,
      bet_id: bet?.id ?? null,
      optimisticBet: bet,
    });
  }

  // The footer row also hosts the hover-reveal placeholder chips (ghost
  // priority dot / ghost assignee avatar) that make the empty priority and
  // assignee fields reachable — see AssigneeStack and the priority button
  // below. So the row has to stay mounted whenever either field is enabled
  // for this view, even with no data to show, not just when it "has content"
  // like the other optional rows.
  const hasFooter =
    showKey ||
    task.is_recurring_instance ||
    showPriority ||
    showAssignee ||
    showReviewer ||
    (showPoints && task.story_points != null) ||
    task.current_column_since != null;

  return (
    <div
      onClick={(e) => {
        // Popover content renders through a React portal, but portal events
        // still bubble up the REACT tree (not the DOM tree), so a click
        // inside any chip popover reaches this handler too. Bail unless the
        // click's actual DOM target is inside the card element itself.
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (!isDragging) {
          e.stopPropagation();
          onClick?.();
        }
      }}
      className={cn(
        "group rounded-lg border bg-card text-[13px]",
        "select-none",
        sortable && "cursor-grab active:cursor-grabbing",
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

      {/* Labels — click opens the labels PropertyPalette (see
          onEditorOpenRequest). Hidden entirely for label-less tasks; `l` on
          a label-less selected card still opens the palette via the board's
          keyboard handler even without a chip to click. */}
      {showLabels && task.labels.length > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEditorOpenRequest?.("labels");
          }}
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
      )}

      {/* Bet chip — which bet this task serves (Cyt OS). Click opens a
          picker over the project's current-period bets. Rendered only when
          the task is linked; unlinked tasks pick up a bet via the task
          panel or the bets page. */}
      {showBet && task.bet && task.project != null && (
        <div className="px-3 pb-1.5">
          <BetChip
            bet={task.bet}
            projectId={task.project}
            onSelect={handleBetSelect}
          />
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

      {/* Single metadata footer: key · priority · points · assignees ·
          reviewer · time. Each item collapses out individually; the row
          hides entirely when empty (unless priority/assignee hover
          placeholders keep it around — see `hasFooter` above). */}
      {hasFooter && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-t border-border/50 text-[11px] text-muted-foreground">
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
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditorOpenRequest?.("priority");
              }}
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
                  className="block size-2.5 rounded-full border border-dashed border-muted-foreground/40 opacity-0 group-hover:opacity-100 hover-none:opacity-100 transition-opacity"
                />
              )}
            </button>
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
              onOpenRequest={() => onEditorOpenRequest?.("assignee")}
            />
          )}
          {showReviewer && task.reviewer && (
            <ReviewerAvatar reviewer={task.reviewer} />
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

/** Bet chip — Target icon + bet name in the bet's color. Click opens a
 *  picker over the project's current-period bets (fetched lazily on open).
 *  The task's own bet is always listed even when it belongs to an older
 *  period, so it stays visible and un-linkable. */
function BetChip({
  bet,
  projectId,
  onSelect,
}: {
  bet: BetRef;
  projectId: number;
  onSelect: (bet: BetRef | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label="Edit bet"
            title={`Bet: ${bet.name}`}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] font-medium max-w-full min-w-0 outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            style={{
              background: withAlpha(bet.color, 0.12),
              color: bet.color,
            }}
          >
            <Target className="size-2.5 shrink-0" />
            <span className="truncate">{bet.name}</span>
          </button>
        }
      />
      <PopoverContent className="w-60 p-1" align="start">
        {open && (
          <BetMenu
            current={bet}
            projectId={projectId}
            onSelect={(next) => {
              onSelect(next);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function BetMenu({
  current,
  projectId,
  onSelect,
}: {
  current: BetRef | null;
  projectId: number;
  onSelect: (bet: BetRef | null) => void;
}) {
  const betsQuery = useBetsQuery(projectId, currentPeriodStart());
  const bets = betsQuery.data ?? [];
  // Keep the task's own bet selectable even if it's from another period.
  const options: (Bet | BetRef)[] =
    current && !bets.some((b) => b.id === current.id)
      ? [...bets, current]
      : bets;

  return (
    <div className="flex flex-col">
      {betsQuery.isLoading && (
        <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
          Loading…
        </p>
      )}
      {options.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() =>
            onSelect({
              id: b.id,
              name: b.name,
              color: b.color,
              status: b.status,
              period_start: b.period_start,
            })
          }
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent"
        >
          <Target className="size-3 shrink-0" style={{ color: b.color }} />
          <span className="truncate flex-1">{b.name}</span>
          {current?.id === b.id && <Check className="size-3 shrink-0" />}
        </button>
      ))}
      {!betsQuery.isLoading && options.length === 0 && (
        <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
          No bets this period.
        </p>
      )}
      {current && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent"
        >
          Remove bet
        </button>
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

/** Stacked avatars with a `+N` overflow bubble. Click opens the assignee
 *  PropertyPalette (see `onOpenRequest`); an empty stack shows a hover-reveal
 *  ghost avatar so the field stays reachable. */
function AssigneeStack({
  task,
  onOpenRequest,
}: {
  task: Task;
  /** Chip click → ask the card to open the assignee palette (bubbles up to
   *  `onEditorOpenRequest` on `KanbanCard`). */
  onOpenRequest?: () => void;
}) {
  const VISIBLE = 3;
  const users = task.assignees;
  const shown = users.slice(0, VISIBLE);
  const extra = users.length - shown.length;
  const singleName = users.length === 1 ? users[0].username : null;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenRequest?.();
      }}
      aria-label="Edit assignees"
      className="flex items-center gap-1.5 min-w-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
    >
      {users.length === 0 ? (
        <span className="size-5 rounded-full border border-dashed border-muted-foreground/40 opacity-0 group-hover:opacity-100 hover-none:opacity-100 transition-opacity grid place-items-center">
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
  );
}

/** Reviewer avatar — resolved from the GitHub PR review webhook (see
 *  `Task.reviewer`). Rendered next to the assignee stack but ringed in the
 *  same emerald tone `LinkedPRBadge` uses for an "open" PR, so it doesn't
 *  get mistaken for another assignee at a glance. */
function ReviewerAvatar({ reviewer }: { reviewer: User }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="shrink-0 rounded-full ring-1 ring-emerald-500/60">
            <UserAvatar
              username={reviewer.username}
              avatarUrl={reviewer.avatar_url}
              size="size-5"
            />
          </div>
        }
      />
      <TooltipContent>Reviewer: {reviewer.username}</TooltipContent>
    </Tooltip>
  );
}
