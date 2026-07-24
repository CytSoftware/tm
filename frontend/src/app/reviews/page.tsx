"use client";

/**
 * /reviews — the user's personal "To Review" queue.
 *
 * Cross-project list of everything waiting on the current user's review,
 * split into three sections (each task appears in exactly one):
 *
 *  - "PRs awaiting your review" — tasks with at least one open linked PR
 *    whose GitHub reviewer is me. The PR badges link straight to GitHub.
 *  - "Tasks to review" — the rest of ``reviewer=me`` (manual reviewer
 *    assignments, or a reviewer left set after the PR closed).
 *  - "Unclaimed reviews" (TAS-064) — tasks sitting in a review-kind column
 *    with no reviewer claimed yet, across all projects. Anyone can claim one
 *    to become its reviewer.
 *
 * Data comes from ``/api/tasks/?reviewer=me`` (TAS-011 rule engine sets
 * ``Task.reviewer`` on ``review_requested`` webhooks) and, for unclaimed
 * reviews, ``/api/tasks/?reviewer=none&column_kind=review``. Rows open the
 * global task overlay in place.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { LinkedPRBadge } from "@/components/integrations/LinkedPRBadge";
import { useClaimReview, useToReviewQuery, useUnclaimedReviewsQuery } from "@/hooks/use-tasks";
import { ApiError } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import { useTaskDialog } from "@/lib/task-dialog";
import type { LinkedPR, Task } from "@/lib/types";

/** PRs that are actionable review targets — open (drafts included: a review
 *  request on a draft is still a request). */
function openPRs(task: Task): LinkedPR[] {
  return task.linked_prs.filter((pr) => pr.state === "open" && !pr.merged);
}

export default function ReviewsPage() {
  const tasksQuery = useToReviewQuery();
  const unclaimedQuery = useUnclaimedReviewsQuery();
  const meQuery = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const claim = useClaimReview();

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const unclaimedTasks = useMemo(
    () => unclaimedQuery.data ?? [],
    [unclaimedQuery.data],
  );
  const githubLogin = (meQuery.data?.github_username ?? "").toLowerCase();

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

  const showGithubHint =
    meQuery.data != null && meQuery.data.github_username === "";

  const isLoading = tasksQuery.isLoading || unclaimedQuery.isLoading;
  const isEmpty =
    !isLoading && tasks.length === 0 && unclaimedTasks.length === 0;

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
      <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-border/80 bg-background">
        <GitPullRequest className="size-4 text-emerald-500" />
        <h1 className="text-[13px] font-semibold tracking-tight">To Review</h1>
        <span className="text-[11px] text-muted-foreground">
          PRs and tasks waiting on your review, plus unclaimed reviews anyone
          can pick up, across all projects.
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
              Nothing waiting on your review.
            </div>
          ) : (
            <>
              <ReviewSection
                title="PRs awaiting your review"
                tasks={prTasks}
              />
              <ReviewSection title="Tasks to review" tasks={otherTasks} />
              <ReviewSection
                title="Unclaimed reviews"
                tasks={unclaimedTasks}
                renderAction={(task) => (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
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
}: {
  title: string;
  tasks: Task[];
  /** Optional per-row action (e.g. the "Claim" button for unclaimed
   *  reviews), rendered at the end of each row. */
  renderAction?: (task: Task) => React.ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="tabular-nums">{tasks.length}</span>
      </h2>
      <div className="rounded-lg border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <ul className="px-3 py-2">
          {tasks.map((t) => (
            <ReviewRow
              key={t.id}
              task={t}
              action={renderAction?.(t)}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ReviewRow({ task, action }: { task: Task; action?: React.ReactNode }) {
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
        className="w-full flex items-center gap-2 rounded-md px-1.5 py-1.5 cursor-pointer hover:bg-accent/50 transition-colors"
      >
        <span
          className="size-2 rounded-full shrink-0"
          style={{ background: task.project_color ?? "var(--muted-foreground)" }}
          title={task.project_name ?? undefined}
        />
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">
          {task.key}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          {task.title}
        </span>
        {prs.map((pr) => (
          <LinkedPRBadge key={pr.id} pr={pr} />
        ))}
        {task.column && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground">
            {task.column.name}
          </span>
        )}
        {action}
      </div>
    </li>
  );
}
