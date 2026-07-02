"use client";

/**
 * Bell + unread badge + inbox popover — mounted as the first entry in the
 * sidebar nav (see Sidebar.tsx) so it's visible in both the collapsed
 * (icon + dot) and expanded (icon + label + count badge) desktop rail, and
 * in the mobile overlay sidebar.
 *
 * Row click behavior: mark read (optimistic), select the notification's
 * project (if any), navigate to `/board`, and — unless the task was
 * deleted — try to open it in the global task panel via `useTaskDialog`.
 * `openTaskByKey` already swallows 404s (task gone/deleted by someone
 * else), so this degrades gracefully to "board with project selected" per
 * the Phase 4 spec without any extra existence check here.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  type LucideIcon,
  MoveRight,
  Pencil,
  Trash2,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDuration } from "@/components/task/TimeInColumn";
import { cn } from "@/lib/utils";
import { useActiveProject } from "@/lib/active-project";
import { useTaskDialog } from "@/lib/task-dialog";
import {
  unreadCountFrom,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationsInfinite,
} from "@/hooks/use-notifications";
import type { Notification } from "@/lib/types";

type Props = {
  collapsed: boolean;
  /** Mobile overlay close callback — called after a row navigates. */
  onNavigate?: () => void;
};

export function NotificationInbox({ collapsed, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const query = useNotificationsInfinite();
  const markAllRead = useMarkAllNotificationsRead();

  const notifications = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.results),
    [query.data],
  );
  const unreadCount = unreadCountFrom(query.data);
  const badgeLabel = unreadCount > 9 ? "9+" : String(unreadCount);

  const triggerButton = (
    <button
      type="button"
      aria-label={unreadCount > 0 ? `Inbox, ${unreadCount} unread` : "Inbox"}
      className={cn(
        "relative transition-colors text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
        collapsed
          ? "w-full grid place-items-center py-1.5 rounded-md"
          : "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px]",
        open && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      <Bell
        className={collapsed ? "size-4" : "size-3.5 shrink-0 text-muted-foreground"}
      />
      {collapsed ? (
        unreadCount > 0 && (
          <span
            className="absolute top-1 right-2 size-1.5 rounded-full bg-primary"
            aria-hidden
          />
        )
      ) : (
        <>
          <span className="truncate flex-1 text-left">Inbox</span>
          {unreadCount > 0 && (
            <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium grid place-items-center tabular-nums">
              {badgeLabel}
            </span>
          )}
        </>
      )}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={triggerButton} />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-[380px] max-h-[70vh] flex flex-col p-0 gap-0"
      >
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/60">
          <span className="text-[13px] font-semibold">Inbox</span>
          {unreadCount > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {unreadCount} unread
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[11px]"
            onClick={() => markAllRead.mutate()}
            disabled={unreadCount === 0 || markAllRead.isPending}
          >
            <CheckCheck className="size-3" />
            Mark all read
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.isLoading && (
            <div className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              Loading…
            </div>
          )}

          {!query.isLoading && notifications.length === 0 && (
            <div className="px-3 py-10 text-center">
              <p className="text-[13px] font-medium text-foreground">
                You&apos;re all caught up
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                New assignments and updates will show up here.
              </p>
            </div>
          )}

          {notifications.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              onNavigated={() => {
                setOpen(false);
                onNavigate?.();
              }}
            />
          ))}

          {query.hasNextPage && (
            <div className="p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-[11px]"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
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

function describeNotification(n: Notification): {
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
