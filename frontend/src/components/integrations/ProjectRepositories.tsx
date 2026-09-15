"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitBranch, RefreshCw, Unlink } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { projectsKey, projectKey, projectRepositoriesKey, githubRepositoriesKey } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

type Repository = {
  repo_id: number;
  repo_full_name: string;
  default_branch: string;
  private?: boolean;
  archived?: boolean;
  installation_id?: number | null;
};
type Repositories = { results: Repository[] };

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const payload = error.payload as { detail?: string; repo_id?: string[] } | null;
    return payload?.detail ?? payload?.repo_id?.[0] ?? "Could not update repositories. Try again.";
  }
  return "Could not reach GitHub. Try again.";
}

export function ProjectRepositories({ projectId, legacyRepo }: { projectId: number; legacyRepo: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState("");
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const path = `/api/integrations/projects/${projectId}/repositories/`;
  const key = projectRepositoriesKey(projectId);
  const available = useQuery({
    queryKey: githubRepositoriesKey(),
    queryFn: () => apiFetch<Repositories>("/api/integrations/github/repositories/"),
    retry: false,
  });
  const linked = useQuery({ queryKey: key, queryFn: () => apiFetch<Repositories>(path) });
  const mutation = useMutation({
    mutationFn: ({ repo, method }: { repo: Repository; method: "POST" | "DELETE" }) =>
      apiFetch(path, { method, body: { repo_id: repo.repo_id } }),
    onSuccess: () => {
      setSelected("");
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: projectKey(projectId) });
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });
  const repos = linked.data?.results ?? [];
  const choices = (available.data?.results ?? []).filter(r => !repos.some(l => l.repo_id === r.repo_id));
  const chosen = choices.find(r => String(r.repo_id) === selected);
  const error = mutation.error ?? refreshError ?? linked.error ?? available.error;

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const data = await apiFetch<Repositories>("/api/integrations/github/repositories/?refresh=true");
      qc.setQueryData(githubRepositoriesKey(), data);
    } catch (error) {
      setRefreshError(error);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="repositories-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="repositories-heading" className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <GitBranch className="size-3" /> GitHub repositories
        </h2>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing || available.isFetching}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Link repositories available to the CytHQ GitHub App. Changes save immediately.</p>
      {linked.isPending ? <p className="text-xs">Loading linked repositories…</p> : repos.map(repo => (
        <div key={repo.repo_id} className="flex items-center justify-between gap-2 rounded-md border p-3">
          <a className="flex min-w-0 items-center gap-2 text-sm hover:underline" href={`https://github.com/${repo.repo_full_name}`} target="_blank" rel="noopener noreferrer">
            <span className="truncate">{repo.repo_full_name}</span><ExternalLink className="size-3 shrink-0" />
          </a>
          {!repo.installation_id && available.data?.results.some(r => r.repo_id === repo.repo_id) && (
            <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ repo, method: "POST" })}>Connect App</Button>
          )}
          <Button variant="ghost" size="sm" disabled={mutation.isPending} aria-label={`Unlink ${repo.repo_full_name}`} onClick={() => {
            if (window.confirm(`Unlink ${repo.repo_full_name}? Its tracked PR associations in this project will be removed. GitHub and tasks are unchanged.`)) {
              mutation.mutate({ repo, method: "DELETE" });
            }
          }}><Unlink className="size-3.5" /> Unlink</Button>
        </div>
      ))}
      {!linked.isPending && !linked.isError && repos.length === 0 && (
        <p className="text-xs text-muted-foreground">{legacyRepo ? `Existing shortcut: ${legacyRepo}. Select it below to connect it through the App.` : "No repositories linked yet."}</p>
      )}
      <div className="flex gap-2">
        <select aria-label="GitHub repository" value={selected} onChange={e => setSelected(e.target.value)} disabled={available.isPending || linked.isPending || linked.isError || mutation.isPending} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm">
          <option value="">{available.isPending ? "Loading GitHub repositories…" : "Select a repository"}</option>
          {choices.map(repo => <option key={repo.repo_id} value={repo.repo_id}>{repo.repo_full_name}{repo.private ? " · Private" : ""}{repo.archived ? " · Archived" : ""}</option>)}
        </select>
        <Button disabled={!chosen || mutation.isPending || linked.isError} onClick={() => chosen && mutation.mutate({ repo: chosen, method: "POST" })}>Link</Button>
      </div>
      {available.isSuccess && available.data.results.length === 0 && <p className="text-xs text-muted-foreground">Install the CytHQ GitHub App on your repositories, then refresh.</p>}
      {error != null && <p role="alert" className="text-xs text-destructive">{errorMessage(error)}</p>}
    </section>
  );
}
