"use client";

/** One next step — a task an update filed: tick it off here, or open it. */

import { Check } from "lucide-react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/UserAvatar";
import { type Step, useSetStepDone } from "@/hooks/use-crm";
import { errorMessage, isOverdue, relativeDay } from "@/lib/crm-meta";
import { useTaskDialog } from "@/lib/task-dialog";
import { cn } from "@/lib/utils";

export function StepRow({
  step: s,
  label,
  className,
}: {
  step: Step;
  /** Muted lead-in before the title, e.g. "Next". */
  label?: string;
  className?: string;
}) {
  const done = useSetStepDone();
  const { openTaskByKey } = useTaskDialog();
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[12px]", className)}>
      <button
        type="button"
        aria-label={s.is_open ? "Mark done" : "Reopen"}
        disabled={done.isPending}
        onClick={() =>
          done.mutate({ key: s.key, done: s.is_open }, { onError: (e) => toast.error(errorMessage(e)) })
        }
        className={cn(
          "tap-target grid size-4 shrink-0 place-items-center rounded-full border",
          s.is_open
            ? "border-muted-foreground/50 hover:border-foreground"
            : "border-emerald-500 bg-emerald-500 text-white",
        )}
      >
        {!s.is_open && <Check className="size-2.5" />}
      </button>
      {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
      <button
        type="button"
        onClick={() => openTaskByKey(s.key)}
        title={`Open ${s.key}`}
        className={cn(
          "min-w-0 flex-1 truncate text-left hover:underline",
          !s.is_open && "text-muted-foreground line-through",
        )}
        dir="auto"
      >
        {s.title}
      </button>
      {s.due_at && s.is_open && (
        <span
          className={cn(
            "shrink-0 tabular-nums",
            isOverdue(s.due_at) ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {relativeDay(s.due_at)}
        </span>
      )}
      {s.assignees.map((u) => (
        <UserAvatar key={u.id} username={u.username} avatarUrl={u.avatar_url} size="size-4" />
      ))}
    </div>
  );
}
