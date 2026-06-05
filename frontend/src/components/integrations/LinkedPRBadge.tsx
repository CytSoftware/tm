"use client";

import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { LinkedPR } from "@/lib/types";

type Props = {
  pr: LinkedPR;
};

type BadgeState = "merged" | "closed" | "draft" | "open";

const STATE_STYLES: Record<
  BadgeState,
  {
    icon: typeof GitPullRequest;
    bg: string;
    text: string;
    border: string;
    label: string;
  }
> = {
  merged: {
    icon: GitMerge,
    bg: "bg-purple-500/10",
    text: "text-purple-600 dark:text-purple-400",
    border: "border-purple-500/30",
    label: "merged",
  },
  closed: {
    icon: GitPullRequestClosed,
    bg: "bg-red-500/10",
    text: "text-red-600 dark:text-red-400",
    border: "border-red-500/30",
    label: "closed",
  },
  draft: {
    icon: GitPullRequestDraft,
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
    label: "draft",
  },
  open: {
    icon: GitPullRequest,
    bg: "bg-emerald-500/10",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-emerald-500/30",
    label: "open",
  },
};

function resolveState(pr: LinkedPR): BadgeState {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.is_draft) return "draft";
  return "open";
}

export function LinkedPRBadge({ pr }: Props) {
  const state = resolveState(pr);
  const style = STATE_STYLES[state];
  const Icon = style.icon;
  const repoLabel = pr.repository?.repo_full_name ?? "";
  const title = repoLabel
    ? `${repoLabel} #${pr.pr_number} — ${pr.pr_title}`
    : `#${pr.pr_number} — ${pr.pr_title}`;

  return (
    <a
      href={pr.html_url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5",
        "text-[10px] font-semibold tracking-wide",
        "transition-colors hover:opacity-90",
        style.bg,
        style.text,
        style.border,
      )}
    >
      <Icon className="size-3" aria-hidden />
      <span className="font-mono">#{pr.pr_number}</span>
      <span className="opacity-80">{style.label}</span>
    </a>
  );
}
