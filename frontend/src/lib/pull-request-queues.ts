export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updated_at: string;
  author: string;
  reviewers: string[];
  teams: string[];
  repository_id: number;
  repository: string;
  projects: { id: number; name: string }[];
  tasks: string[];
}

export interface PullRequestResponse {
  results: GitHubPullRequest[];
  repositories: { id: number; name: string; projects: { id: number; name: string }[] }[];
  errors: string[];
}

export function pullRequestQueues(prs: GitHubPullRequest[], username?: string, project = "", repository = "") {
  const filtered = prs.filter(pr => (!project || pr.projects.some(p => String(p.id) === project)) &&
    (!repository || String(pr.repository_id) === repository));
  const mine = (pr: GitHubPullRequest) => Boolean(username && pr.reviewers.some(login => login.toLowerCase() === username.toLowerCase()));
  const assigned = (pr: GitHubPullRequest) => pr.reviewers.length > 0 || pr.teams.length > 0;
  return {
    mine: filtered.filter(mine),
    others: filtered.filter(pr => assigned(pr) && !mine(pr)),
    unassigned: filtered.filter(pr => !assigned(pr)),
    all: filtered,
  };
}
