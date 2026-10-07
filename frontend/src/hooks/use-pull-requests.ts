import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { githubPullRequestsKey } from "@/lib/query-keys";
import type { PullRequestResponse } from "@/lib/pull-request-queues";

export function usePullRequestsQuery(enabled = true) {
  return useQuery({
    enabled,
    queryKey: githubPullRequestsKey(),
    queryFn: () => apiFetch<PullRequestResponse>("/api/integrations/github/pull-requests/"),
    refetchInterval: 60_000,
  });
}
