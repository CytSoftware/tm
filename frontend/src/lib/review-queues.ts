import type { Task } from "./types";

export const REVIEW_TABS = [
  { value: "mine", label: "Mine" },
  { value: "others", label: "Others" },
  { value: "unassigned", label: "Unassigned" },
  { value: "all", label: "All" },
] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number]["value"];

export function reviewQueues(sources: Task[][], userId: number | undefined, project = "", repository = "") {
  const byId = new Map<number, Task>();
  for (const task of sources.flat()) {
    const previous = byId.get(task.id);
    // Independent polls can contain different snapshots after a review is claimed.
    if (!previous || Date.parse(task.updated_at) > Date.parse(previous.updated_at)) byId.set(task.id, task);
  }
  const all = [...byId.values()].filter(task => !task.column?.is_done && (
    (userId != null && task.reviewer?.id === userId) || task.column?.kind === "review"
  )).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.id - b.id);
  const filtered = all.filter(task =>
    (!project || String(task.project) === project) &&
    (!repository || task.linked_prs.some(pr => pr.state === "open" && !pr.merged && String(pr.repository?.repo_id) === repository)),
  );
  return {
    allTasks: all,
    queues: {
      mine: filtered.filter(task => userId != null && task.reviewer?.id === userId),
      others: filtered.filter(task => task.reviewer != null && task.reviewer.id !== userId),
      unassigned: filtered.filter(task => task.reviewer == null),
      all: filtered,
    },
  };
}

export async function fetchReviewTasks(
  path: string,
  fetchPage: (path: string) => Promise<{ results: Task[]; next: string | null }>,
): Promise<Task[]> {
  const tasks: Task[] = [];
  let next = true;
  while (next) {
    const page = await fetchPage(`${path}&offset=${tasks.length}`);
    tasks.push(...page.results);
    next = Boolean(page.next);
    if (next && page.results.length === 0) throw new Error("Review pagination returned an empty page.");
  }
  return tasks;
}

