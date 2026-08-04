"use client";

/**
 * /reviews — the whole review landscape, across every project.
 *
 * Sections, in "how much does this need me" order (each task appears in
 * exactly one — later sections subtract the earlier ones by task id):
 *
 *  - "PRs awaiting your review" — tasks with at least one open linked PR
 *    whose GitHub reviewer is me. The PR badges link straight to GitHub.
 *  - "Tasks to review" — the rest of ``reviewer=me`` (manual reviewer
 *    assignments, or a reviewer left set after the PR closed).
 *  - "Unclaimed reviews" (TAS-064) — tasks sitting in a review-kind column
 *    with no reviewer claimed yet. Anyone can claim one to become its
 *    reviewer.
 *  - "In review with others" (TAS-067) — everything else in a review-kind
 *    column, i.e. someone else's queue. Read-only context: it answers "is
 *    my PR being looked at" without pinging anyone.
 *
 * Data comes from ``/api/tasks/?reviewer=me`` (TAS-011 rule engine sets
 * ``Task.reviewer`` on ``review_requested`` webhooks), ``?reviewer=none&
 * column_kind=review`` for unclaimed reviews, and ``?column_kind=review``
 * for the workspace-wide set. Rows open the global task overlay in place.
 *
 * Note the sidebar's "To Review" badge deliberately stays the needs-you
 * count — the others section is context, not a queue.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LinkedPRBadge } from "@/components/integrations/LinkedPRBadge";
import { UserAvatar } from "@/components/UserAvatar";
import { formatDuration } from "@/components/task/TimeInColumn";
import {
  useAllInReviewQuery,
  useClaimReview,
  useToReviewQuery,
  useUnclaimedReviewsQuery,
} from "@/hooks/use-tasks";
import { ApiError } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import { useTaskDialog } from "@/lib/task-dialog";
import { cn } from "@/lib/utils";
import { PRIORITY_DOT, PRIORITY_TEXT } from "@/lib/types";
import type { LinkedPR, Task, User } from "@/lib/types";

/** PRs that are actionable review targets — open (drafts included: a review
 *  request on a draft is still a request). */
function openPRs(task: Task): LinkedPR[] {
  return task.linked_prs.filter((pr) => pr.state === "open" && !pr.merged);
}

/** "2h ago" / "3d ago" from an ISO timestamp, reusing the compact duration
 *  formatter the card/notification rows already share. `formatDuration`
 *  returns "just now" under a minute, which already reads as past tense. */
function relativeSince(iso: string): string {
  const d = formatDuration(iso);
  return d === "just now" ? d : `${d} ago`;
}

export default function ReviewsPage() {
  const tasksQuery = useToReviewQuery();
  const unclaimedQuery = useUnclaimedReviewsQuery();
  const allInReviewQuery = useAllInReviewQuery();
  const meQuery = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const claim = useClaimReview();

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  // The three fetches land independently, so a reviewer change between them
  // can leave the same task in two responses. Each list subtracts the ones
  // above it by id, which is what makes the "exactly one section" rule hold.
  const unclaimedTasks = useMemo(() => {
    const mine = new Set(tasks.map((t) => t.id));
    return (unclaimedQuery.data ?? []).filter((t) => !mine.has(t.id));
  }, [unclaimedQuery.data, tasks]);
  const allInReview = useMemo(
    () => allInReviewQuery.data ?? [],
    [allInReviewQuery.data],
  );
  const githubLogin = (meQuery.data?.github_username ?? "").toLowerCase();
  const meId = meQuery.data?.id;

  const { prTasks, otherTasks } = useMemo(() => {
    const awaitsMyPrReview = (t: Task) =>
      openPRs(t).some((pr) =>
        githubLogin
          ? pr.reviewer_login.toLowerCase() === githubLogin
          : pr.reviewer_login !== "",
      );
    const prTasks: Task[] = [];
    const otherTasks: Task[] = [];
    for (const t of tasks) (awaitsMyPrReview(t) ? prTasks : otherTasks).push(t);
    return { prTasks, otherTasks };
  }, [tasks, githubLogin]);

  // Someone else's queue: the workspace-wide set minus everything already
  // rendered above. Tasks whose reviewer is me are dropped even if the
  // reviewer=me fetch hasn't caught up yet — better a row missing for one
  // poll than my own review filed under "other people".
  const othersTasks = useMemo(() => {
    if (meId == null) return [];
    const shown = new Set([...tasks, ...unclaimedTasks].map((t) => t.id));
    return allInReview.filter(
      (t) => t.reviewer != null && t.reviewer.id !== meId && !shown.has(t.id),
    );
  }, [allInReview, tasks, unclaimedTasks, meId]);

  const showGithubHint =
    meQuery.data != null && meQuery.data.github_username === "";

  // `Shell` gates the whole tree on `me`, so `meId` is resolved by the time
  // this renders — only the task queries can be in flight here.
  const needsMeCount = tasks.length + unclaimedTasks.length;
  const needsMeLoading = tasksQuery.isLoading || unclaimedQuery.isLoading;
  // The workspace-wide query is secondary: it must not hold back the queue
  // sections, which the sidebar usually has cached already. It only gates
  // the spinner when there'd be nothing on screen without it.
  const isLoading =
    needsMeLoading || (needsMeCount === 0 && allInReviewQuery.isLoading);
  const loadFailed =
    tasksQuery.isError || unclaimedQuery.isError || allInReviewQuery.isError;

  // Two distinct "nothing here" states: a genuinely quiet workspace, versus
  // a clear personal queue while other people still have work in review.
  const queueClear = !isLoading && needsMeCount === 0;
  const isEmpty = queueClear && othersTasks.length === 0;

  function handleClaim(task: Task) {
    claim.mutate(task.key, {
      onSuccess: () => toast.success(`You're reviewing ${task.key}`),
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          toast.error("Someone else already claimed this review.");
        } else {
          toast.error("Couldn't claim review.");
        }
      },
    });
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 max-lg:px-3 py-1.5 border-b border-border/80 bg-background">
        <GitPullRequest className="size-4 text-emerald-500" />
        <h1 className="text-[13px] font-semibold tracking-tight">To Review</h1>
        <span className="hidden md:inline text-[11px] text-muted-foreground">
          Everything in review across all projects — what&apos;s waiting on
          you, what&apos;s unclaimed, and what others are reviewing.
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto max-w-3xl px-4 py-5 space-y-5">
          {showGithubHint && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-700 dark:text-amber-400">
              Your account has no GitHub username mapped, so PR review requests
              can&apos;t be routed to you. Set it in the Django admin (user
              profile &rarr; GitHub username).
            </div>
          )}

          {isLoading ? (
            <div className="grid place-items-center py-16">
              <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
            </div>
          ) : isEmpty ? (
            <div className="rounded-lg border border-border/60 bg-card py-14 px-6 text-center text-[12.5px] text-muted-foreground">
              {loadFailed
                ? "Couldn't load reviews. Retrying shortly."
                : "Nothing is in review anywhere right now."}
            </div>
          ) : (
            <>
              {/* Queue clear, but the workspace isn't — say so, then still
                  render the others section underneath as context. */}
              {queueClear && (
                <div className="rounded-lg border border-border/60 bg-card py-8 px-6 text-center">
                  <p className="text-[12.5px] font-medium">
                    Nothing needs your review.
                  </p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    {othersTasks.length}{" "}
                    {othersTasks.length === 1 ? "task is" : "tasks are"} in
                    review with other people.
                  </p>
                </div>
              )}

              <ReviewSection title="PRs awaiting your review" tasks={prTasks} />
              <ReviewSection title="Tasks to review" tasks={otherTasks} />
              <ReviewSection
                title="Unclaimed reviews"
                tasks={unclaimedTasks}
                renderAction={(task) => (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] tap-target"
                    disabled={claim.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClaim(task);
                    }}
                  >
                    Claim
                  </Button>
                )}
              />
              <ReviewSection
                title="In review with others"
                tasks={othersTasks}
                showReviewer
                subdued
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewSection({
  title,
  tasks,
  renderAction,
  showReviewer,
  subdued,
}: {
  title: string;
  tasks: Task[];
  /** Optional per-row action (e.g. the "Claim" button for unclaimed
   *  reviews), rendered at the end of each row. */
  renderAction?: (task: Task) => React.ReactNode;
  /** Surface the reviewer avatar + name on each row. Only "In review with
   *  others" needs it — everywhere else the reviewer is me or nobody. */
  showReviewer?: boolean;
  /** Read-only context rather than a queue: flattened card, dimmed titles.
   *  Still full-contrast enough to read — just clearly not actionable. */
  subdued?: boolean;
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="tabular-nums">{tasks.length}</span>
      </h2>
      <div
        className={cn(
          "rounded-lg border",
          subdued
            ? "border-border/40 bg-card/50"
            : "border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        )}
      >
        <ul className="px-3 py-2">
          {tasks.map((t) => (
            <ReviewRow
              key={t.id}
              task={t}
              action={renderAction?.(t)}
              showReviewer={showReviewer}
              subdued={subdued}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ReviewRow({
  task,
  action,
  showReviewer,
  subdued,
}: {
  task: Task;
  action?: React.ReactNode;
  showReviewer?: boolean;
  subdued?: boolean;
}) {
  const { openTaskByKey } = useTaskDialog();
  const prs = openPRs(task);

  // The row is a clickable div, not a <button> — the PR badges (and the
  // optional action button) inside are real interactive elements (nesting
  // <a>/<button> in <button> is invalid HTML). Both call stopPropagation so
  // their clicks don't also open the task overlay.
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => void openTaskByKey(task.key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void openTaskByKey(task.key);
          }
        }}
        className="w-full flex flex-wrap items-center gap-2 rounded-md px-1.5 py-1.5 cursor-pointer hover:bg-accent/50 transition-colors"
      >
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: task.project_color ?? "var(--muted-foreground)" }}
          title={task.project_name ?? undefined}
        />
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">
          {task.key}
        </span>
        {task.priority && (
          <span
            className={cn(
              "shrink-0 inline-flex items-center gap-1 font-mono text-[10px] font-semibold tracking-wider",
              PRIORITY_TEXT[task.priority],
            )}
            title={`Priority ${task.priority}`}
          >
            <span
              className={cn("size-2 rounded-full", PRIORITY_DOT[task.priority])}
            />
            {task.priority}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 flex-1 basis-40 truncate text-[12.5px]",
            subdued && "text-muted-foreground",
          )}
        >
          {task.title}
        </span>
        {prs.map((pr) => (
          <LinkedPRBadge key={pr.id} pr={pr} />
        ))}
        {showReviewer && task.reviewer && (
          <ReviewerChip reviewer={task.reviewer} />
        )}
        <AssigneeAvatars assignees={task.assignees} />
        {task.column && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground">
            {task.column.name}
          </span>
        )}
        <span
          className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70"
          title={new Date(task.updated_at).toLocaleString()}
        >
          {relativeSince(task.updated_at)}
        </span>
        {action}
      </div>
    </li>
  );
}

/** The reviewer, named — this is the whole point of the "In review with
 *  others" section, so unlike the kanban card's bare avatar it carries the
 *  username inline at every width (the row wraps rather than dropping it;
 *  "who has it" is the one thing this section exists to answer). Emerald,
 *  matching the card's `ReviewerAvatar`, so it doesn't read as another
 *  assignee. */
function ReviewerChip({ reviewer }: { reviewer: User }) {
  return (
    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 py-0.5 pl-0.5 pr-2">
      <UserAvatar
        username={reviewer.username}
        avatarUrl={reviewer.avatar_url}
        size="size-5"
      />
      <span className="max-w-24 truncate text-[11px] text-emerald-700 dark:text-emerald-400">
        {reviewer.username}
      </span>
    </span>
  );
}

/** Who the work belongs to, at a glance. Capped at two avatars + a `+N`
 *  bubble so the row stays one line on desktop. */
function AssigneeAvatars({ assignees }: { assignees: User[] }) {
  const VISIBLE = 2;
  if (assignees.length === 0) return null;
  const shown = assignees.slice(0, VISIBLE);
  const extra = assignees.length - shown.length;

  return (
    <div className="shrink-0 flex items-center -space-x-1.5">
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
  );
}
