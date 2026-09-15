"use client";

/** Open GitHub pull requests across project repositories. */

import { usePullRequestsQuery } from "@/hooks/use-pull-requests";
import { useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { REVIEW_TABS, type ReviewTab } from "@/lib/review-queues";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey, githubPullRequestsKey } from "@/lib/query-keys";
import { useTaskDialog } from "@/lib/task-dialog";
import { pullRequestQueues, type PullRequestResponse } from "@/lib/pull-request-queues";

export default function ReviewsPage() {
  const prsQuery = usePullRequestsQuery();
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const { openTaskByKey } = useTaskDialog();
  const [tab, setTab] = useState<ReviewTab>("mine");
  const [project, setProject] = useState("");
  const [repository, setRepository] = useState("");
  const [refreshingManually, setRefreshingManually] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const queues = pullRequestQueues(prsQuery.data?.results ?? [], meQuery.data?.github_username, project, repository);
  const repos = prsQuery.data?.repositories ?? [];
  const projects = [...new Map(repos.flatMap(r => r.projects).map(p => [String(p.id), p.name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const repositories = repos.filter(r => !project || r.projects.some(p => String(p.id) === project))
    .map(r => [String(r.id), r.name]).sort((a, b) => a[1].localeCompare(b[1]));
  const isLoading = prsQuery.isPending || meQuery.isPending;
  const loadFailed = prsQuery.isError || meQuery.isError || Boolean(prsQuery.data?.errors.length) || Boolean(refreshError);
  const refreshing = prsQuery.isFetching || refreshingManually;
  const showGithubHint = meQuery.data?.github_username === "";
  const hasFilters = Boolean(project || repository);

  async function refresh() {
    setRefreshingManually(true);
    setRefreshError("");
    try {
      const data = await apiFetch<PullRequestResponse>("/api/integrations/github/pull-requests/?refresh=true");
      queryClient.setQueryData(githubPullRequestsKey(), data);
      await meQuery.refetch();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Couldn’t refresh pull requests.");
    } finally {
      setRefreshingManually(false);
    }
  }

  return (
    <Tabs.Root value={tab} onValueChange={value => setTab(value as ReviewTab)} className="h-full min-h-0 min-w-0 flex flex-col">
      <header className="shrink-0 flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <GitPullRequest className="size-4 text-emerald-500" />
        <h1 className="text-sm font-semibold">Reviews</h1>
        <span className="text-xs text-muted-foreground">Open PRs from linked repositories</span>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={refreshing} onClick={() => void refresh()}>
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
          {loadFailed && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive">Couldn’t load all reviews. The list may be incomplete. Use Refresh to retry.
            {[prsQuery.error?.message, meQuery.error?.message, refreshError, ...(prsQuery.data?.errors ?? [])].filter(Boolean).map((message, i) => <p key={i} className="mt-1">{message}</p>)}</div>}
          {REVIEW_TABS.map(({ value, label }) => (
            <Tabs.Panel key={value} value={value}>
              {isLoading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading reviews…</p> : queues[value].length === 0 ? (
                <div className="rounded-lg border bg-card px-6 py-12 text-center">
                  <p className="text-sm font-medium">{loadFailed ? "Reviews are unavailable." : hasFilters ? "No reviews match these filters." : value === "mine" ? "Nothing is assigned to you for review." : "No reviews in this queue."}</p>
                  {!hasFilters && value === "mine" && queues.unassigned.length > 0 && <Button variant="link" onClick={() => setTab("unassigned")}>Browse {queues.unassigned.length} unassigned reviews</Button>}
                </div>
              ) : (
                <ul aria-label={`${label} pull requests`} className="divide-y rounded-lg border bg-card">
                  {queues[value].map(pr => (
                    <li key={pr.id} className="space-y-2 px-4 py-3">
                      <div className="flex items-start gap-2">
                        <GitPullRequest aria-hidden className={`mt-0.5 size-4 shrink-0 ${pr.draft ? "text-muted-foreground" : "text-emerald-500"}`} />
                        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words text-sm font-medium hover:underline">{pr.title}</a>
                        {pr.draft && <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">Draft</span>}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{pr.repository} #{pr.number}</span>
                        <span>by {pr.author}</span>
                        <span>{pr.reviewers.length || pr.teams.length ? `Requested: ${[...pr.reviewers, ...pr.teams.map(team => `team/${team}`)].join(", ")}` : "No pending review requests"}</span>
                      </div>
                      {pr.tasks.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="Linked tasks">
                        {pr.tasks.map(key => <button key={key} type="button" onClick={() => void openTaskByKey(key)} className="rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open task ${key}`}>{key}</button>)}
                      </div>}
                    </li>
                  ))}
                </ul>
              )}
            </Tabs.Panel>
          ))}
        </div>
      </div>
    </Tabs.Root>
  );
}
