/**
 * Shared "Copy Task ID" / "Copy Prompt" logic — used by the board's
 * keyboard shortcuts, TaskPanel's header buttons + shortcuts, and the
 * command palette's task-scoped actions (TAS-055).
 */

import { toast } from "sonner";

import type { LinkedPR, Task } from "@/lib/types";

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

/** Cmd on macOS, Ctrl everywhere else — the OS-conventional "primary"
 *  modifier, as opposed to `e.metaKey || e.ctrlKey` (which would also fire
 *  on Ctrl-held-on-mac and clash with native shortcuts there). */
export function isPrimaryModifier(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** True when the user has a non-empty, non-collapsed text selection — used
 *  to let native ⌘C copy the selection instead of hijacking it. */
export function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return sel.toString().length > 0;
}

/** True for inputs/textareas/selects and contenteditable hosts (TipTap's
 *  description editor, the palette's search input, etc.) — anywhere native
 *  ⌘C should win over the task-copy shortcuts. */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function prStatusLabel(pr: LinkedPR): string {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.is_draft) return "draft";
  return "open";
}

/** Joins non-empty `label: value` segments with " · ", or returns null if
 *  every segment in the line is empty (the whole line gets dropped). */
function metaLine(segments: { label: string; value: string }[]): string | null {
  const parts = segments
    .filter((s) => s.value.trim() !== "")
    .map((s) => `**${s.label}:** ${s.value}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Builds the full-context markdown block pasted into an agent. `overrides`
 *  lets callers (TaskPanel) substitute live unsaved form state for
 *  `title`/`description` instead of the last-saved task fields. */
export function buildTaskPrompt(
  task: Task,
  overrides?: { title?: string; description?: string },
): string {
  const title = overrides?.title?.trim() || task.title;
  const description = (overrides?.description ?? task.description).trim();

  const line1 = metaLine([
    { label: "Project", value: task.project_prefix ?? "" },
    { label: "Column", value: task.column?.name ?? "" },
    { label: "Priority", value: task.priority ?? "" },
  ]);
  const line2 = metaLine([
    { label: "Labels", value: task.labels.map((l) => l.name).join(", ") },
    {
      label: "Assignees",
      value: task.assignees.map((u) => u.username).join(", "),
    },
    { label: "Due", value: task.due_at ? task.due_at.slice(0, 10) : "" },
  ]);

  const metaBlock: string[] = [];
  if (line1) metaBlock.push(line1);
  if (line2) metaBlock.push(line2);
  if (task.linked_prs.length > 0) {
    metaBlock.push("**Linked PRs:**");
    for (const pr of task.linked_prs) {
      metaBlock.push(
        `- #${pr.pr_number} ${pr.pr_title} (${prStatusLabel(pr)}) — ${pr.html_url}`,
      );
    }
  }

  // Review-mode prompt for tasks sitting in a review column; the default
  // work prompt encodes the usual ritual (plan → branch → PR → move task)
  // so the paste replaces the follow-up messages normally typed by hand.
  const inReview = /review/i.test(task.column?.name ?? "");
  const inProgress = /progress/i.test(task.column?.name ?? "");

  const lines: string[] = [
    inReview
      ? `Let's review ${task.key} from the Cyt task manager — it's in review.`
      : `Let's work on ${task.key} from the Cyt task manager.`,
    "",
    `# ${task.key} — ${title}`,
  ];

  if (metaBlock.length > 0) {
    lines.push("", ...metaBlock);
  }

  if (description) {
    lines.push("", "## Description", "", description);
  }

  lines.push("", "---", "");
  if (inReview) {
    const target =
      task.linked_prs.length > 0
        ? "Review the linked PR(s) thoroughly against the task"
        : "Review the latest changes on this task's branch against the task";
    lines.push(
      `${target} — correctness, edge cases, and whether it fully covers the description. Answer concisely: good to merge, or list what needs fixing by severity. If it's good, tell me — once I confirm, merge and move ${task.key} to Done via the task manager MCP.`,
    );
  } else {
    lines.push(
      "Plan this out thoroughly first — ask me for clarifications if needed, then present the implementation plan before implementing. ultrathink",
      "",
      [
        "Work on a new branch.",
        inProgress
          ? null
          : `Move ${task.key} to In Progress and assign it to me via the task manager MCP.`,
        `When done: run lint/build, commit, push and open a PR to main, then move ${task.key} to In Review.`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  return lines.join("\n");
}

export async function copyTaskId(task: Pick<Task, "key">): Promise<void> {
  try {
    // navigator.clipboard.writeText requires a secure context + document
    // focus — both can fail silently, hence the try/catch + error toast.
    await navigator.clipboard.writeText(task.key);
    toast.success(`Copied ${task.key}`);
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

export async function copyTaskPrompt(
  task: Task,
  overrides?: { title?: string; description?: string },
): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildTaskPrompt(task, overrides));
    toast.success("Prompt copied");
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}
