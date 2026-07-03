"use client";

/**
 * One inbox row — icon, actor/verb sentence, relative time, unread dot.
 * Shared by the sidebar inbox popover and the dashboard activity feed.
 *
 * Row click behavior: mark read (optimistic), select the notification's
 * project (if any), navigate to `/board`, and — unless the task was
 * deleted — try to open it in the global task panel via `useTaskDialog`.
 * `openTaskByKey` already swallows 404s (task gone/deleted by someone
 * else), so this degrades gracefully to "board with project selected".
 */

import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCircle2,
  type LucideIcon,
  MoveRight,
  Pencil,
  Trash2,
  UserPlus,
} from "lucide-react";

import { formatDuration } from "@/components/task/TimeInColumn";
import { cn } from "@/lib/utils";
import { useActiveProject } from "@/lib/active-project";
import { useTaskDialog } from "@/lib/task-dialog";
import { useMarkNotificationRead } from "@/hooks/use-notifications";
import type { Notification } from "@/lib/types";

export function NotificationRow({
  notification,
  onNavigated,
}: {
  notification: Notification;
  onNavigated: () => void;
}) {
  const router = useRouter();
  const { setProjectId } = useActiveProject();
  const { openTaskByKey } = useTaskDialog();
  const markRead = useMarkNotificationRead();

  const unread = notification.read_at === null;
  const { Icon, text } = describeNotification(notification);
  const when = formatDuration(notification.created_at);

  function handleClick() {
    if (unread) markRead.mutate(notification.id);
    if (notification.project) setProjectId(notification.project.id);
    router.push("/board");
    // The task may have been deleted since — openTaskByKey swallows 404s,
    // so worst case this is a no-op and the user still lands on the board
    // with the right project selected.
    if (notification.verb !== "deleted") {
      void openTaskByKey(notification.task_key);
    }
    onNavigated();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "w-full flex items-start gap-2.5 px-3 py-2.5 text-left border-b border-border/40 last:border-b-0 transition-colors hover:bg-accent/50",
        unread && "bg-primary/5",
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-1.5 rounded-full shrink-0",
          unread ? "bg-primary" : "bg-transparent",
        )}
        aria-hidden
      />
      <Icon className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug text-foreground">{text}</p>
        <p className="text-[11px] text-muted-foreground/80 mt-0.5">
          {when} ago
        </p>
      </div>
    </button>
  );
}

export function describeNotification(n: Notification): {
  Icon: LucideIcon;
  text: React.ReactNode;
} {
  const actorName = n.actor?.username ?? "System";
  const keyEl = <span className="font-mono text-[11.5px]">{n.task_key}</span>;

  switch (n.verb) {
    case "assigned":
      return {
        Icon: UserPlus,
        text: (
          <>
            <strong className="font-medium">{actorName}</strong> assigned you{" "}
            {keyEl}
            {n.task_title && <> · {n.task_title}</>}
          </>
        ),
      };
    case "moved": {
      const from = n.payload.from_column;
      const to = n.payload.to_column ?? "—";
      return {
        Icon: MoveRight,
        text: (
          <>
            <strong className="font-medium">{actorName}</strong> moved {keyEl}{" "}
            {from ? (
              <>
                from {from} to {to}
              </>
            ) : (
              <>to {to}</>
            )}
          </>
        ),
      };
    }
    case "updated": {
      const fields = n.payload.changed_fields ?? [];
      return {
        Icon: Pencil,
        text: (
          <>
            <strong className="font-medium">{actorName}</strong> updated{" "}
            {keyEl}
            {fields.length > 0 && <> ({fields.join(", ")})</>}
          </>
        ),
      };
    }
    case "completed":
      return {
        Icon: CheckCircle2,
        text: (
          <>
            <strong className="font-medium">{actorName}</strong> completed{" "}
            {keyEl}
            {n.task_title && <> · {n.task_title}</>}
          </>
        ),
      };
    case "deleted":
      return {
        Icon: Trash2,
        text: (
          <>
            <strong className="font-medium">{actorName}</strong> deleted{" "}
            {keyEl}
            {n.task_title && <> · {n.task_title}</>}
          </>
        ),
      };
    default:
      return {
        Icon: Bell,
        text: (
          <>
            <strong className="font-medium">{actorName}</strong> updated{" "}
            {keyEl}
          </>
        ),
      };
  }
}
