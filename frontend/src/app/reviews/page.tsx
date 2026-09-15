"use client";

/** Task-linked PRs and manual reviews, grouped by reviewer across projects. */

import { useMemo, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { REVIEW_TABS, reviewQueues, type ReviewTab } from "@/lib/review-queues";
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

  const [tab, setTab] = useState<ReviewTab>("mine");
  const [project, setProject] = useState("");
  const [repository, setRepository] = useState("");
  const { allTasks, queues } = useMemo(() => reviewQueues(
    [tasksQuery.data ?? [], unclaimedQuery.data ?? [], allInReviewQuery.data ?? []],
    meQuery.data?.id, project, repository,
  ), [tasksQuery.data, unclaimedQuery.data, allInReviewQuery.data, meQuery.data?.id, project, repository]);
  const projects = [...new Map(allTasks.filter(t => t.project != null).map(t => [String(t.project), t.project_name ?? t.project_prefix ?? "Project"])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const repositories = [...new Map(allTasks.filter(t => !project || String(t.project) === project)
    .flatMap(t => openPRs(t)).filter(pr => pr.repository != null)
    .map(pr => [String(pr.repository!.repo_id), pr.repository!.repo_full_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const queries = [tasksQuery, unclaimedQuery, allInReviewQuery, meQuery];
  const isLoading = queries.some(query => query.isPending);
  const loadFailed = queries.some(query => query.isError);
  const refreshing = queries.some(query => query.isFetching);
  const showGithubHint = meQuery.data?.github_username === "";
  const selectedTasks = queues[tab];
  const hasFilters = Boolean(project || repository);

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
    <Tabs.Root value={tab} onValueChange={value => setTab(value as ReviewTab)} className="h-full min-h-0 min-w-0 flex flex-col">
      <header className="shrink-0 flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <GitPullRequest className="size-4 text-emerald-500" />
        <h1 className="text-sm font-semibold">Reviews</h1>
        <span className="text-xs text-muted-foreground">Task-linked PRs and manual reviews</span>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={refreshing} onClick={() => queries.forEach(query => void query.refetch())}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </header>
      <div className="shrink-0 border-b px-4 pt-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select aria-label="Filter by project" className="h-8 max-w-full rounded-md border bg-background px-2 text-xs" value={project} onChange={e => { setProject(e.target.value); setRepository(""); }}>
            <option value="">All projects</option>
            {project && !projects.some(([id]) => id === project) && <option value={project}>Selected project (no reviews)</option>}
            {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="Filter by repository" className="h-8 max-w-full rounded-md border bg-background px-2 text-xs" value={repository} onChange={e => setRepository(e.target.value)}>
            <option value="">All repositories</option>
            {repository && !repositories.some(([id]) => id === repository) && <option value={repository}>Selected repository (no reviews)</option>}
            {repositories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          {hasFilters && <Button size="sm" variant="ghost" onClick={() => { setProject(""); setRepository(""); }}>Clear filters</Button>}
        </div>
        <Tabs.List aria-label="Review queues" className="flex overflow-x-auto gap-1">
          {REVIEW_TABS.map(({ value, label }) => (
            <Tabs.Tab key={value} value={value} className="shrink-0 border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground data-[active]:border-primary data-[active]:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              {label} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{isLoading || loadFailed ? "—" : queues[value].length}</span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-5">
          {showGithubHint && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            Your GitHub username isn’t mapped yet. Ask a workspace administrator to set it in your user profile so PR requests reach your queue.
          </p>}
          {loadFailed && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive">Couldn’t load all reviews. The list may be incomplete. Use Refresh to retry.</div>}
          {REVIEW_TABS.map(({ value, label }) => (
            <Tabs.Panel key={value} value={value}>
              {isLoading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading reviews…</p> : selectedTasks.length === 0 ? (
                <div className="rounded-lg border bg-card px-6 py-12 text-center">
                  <p className="text-sm font-medium">{loadFailed ? "Reviews are unavailable." : hasFilters ? "No reviews match these filters." : value === "mine" ? "Nothing is assigned to you for review." : "No reviews in this queue."}</p>
                  {!hasFilters && value === "mine" && queues.unassigned.length > 0 && <Button variant="link" onClick={() => setTab("unassigned")}>Browse {queues.unassigned.length} unassigned reviews</Button>}
                </div>
              ) : (
                <ReviewSection title={`${label} · ${selectedTasks.length === 1 ? "review" : "reviews"}`} tasks={selectedTasks} showReviewer repository={repository}
                  renderAction={task => task.reviewer == null ? (
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={claim.isPending} onClick={e => { e.stopPropagation(); handleClaim(task); }}>Claim</Button>
                  ) : null}
                />
              )}
            </Tabs.Panel>
          ))}
        </div>
      </div>
    </Tabs.Root>
  );
}

function ReviewSection({
  title,
  tasks,
  renderAction,
  showReviewer,
  repository,
}: {
  title: string;
  tasks: Task[];
  /** Optional per-row action (e.g. the "Claim" button for unclaimed
   *  reviews), rendered at the end of each row. */
  renderAction?: (task: Task) => React.ReactNode;
  /** Show the assigned reviewer alongside the task's assignees. */
  showReviewer?: boolean;
  repository?: string;
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
              showReviewer={showReviewer}
              repository={repository}
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
  repository,
}: {
  task: Task;
  action?: React.ReactNode;
  showReviewer?: boolean;
  repository?: string;
}) {
  const { openTaskByKey } = useTaskDialog();
  const prs = openPRs(task).filter(pr => !repository || String(pr.repository?.repo_id) === repository);

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
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
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
          className="min-w-0 flex-1 basis-40 truncate text-[12.5px]"
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
