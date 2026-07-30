"use client";

/**
 * Bell + unread badge + inbox popover — mounted as the first entry in the
 * sidebar nav (see Sidebar.tsx) so it's visible in both the collapsed
 * (icon + dot) and expanded (icon + label + count badge) desktop rail, in
 * the mobile overlay sidebar, and (as `variant="topbar"`) in the mobile
 * slim top bar (see Shell.tsx).
 *
 * Row rendering + click behavior live in NotificationRow (shared with the
 * dashboard activity feed).
 */

import { useMemo, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { cn } from "@/lib/utils";
import {
  unreadCountFrom,
  useMarkAllNotificationsRead,
  useNotificationsInfinite,
} from "@/hooks/use-notifications";

type Props = {
  variant: "sidebar" | "sidebar-collapsed" | "topbar";
  /** Mobile overlay close callback — called after a row navigates. */
  onNavigate?: () => void;
};

export function NotificationInbox({ variant, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const query = useNotificationsInfinite();
  const markAllRead = useMarkAllNotificationsRead();

  const notifications = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.results),
    [query.data],
  );
  const unreadCount = unreadCountFrom(query.data);
  const badgeLabel = unreadCount > 9 ? "9+" : String(unreadCount);
  const collapsed = variant === "sidebar-collapsed";

  const triggerButton =
    variant === "topbar" ? (
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Inbox, ${unreadCount} unread` : "Inbox"}
        className={cn(
          "tap-target relative size-8 rounded-md grid place-items-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors",
          open && "bg-muted text-foreground",
        )}
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span
            className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
            aria-hidden
          />
        )}
      </button>
    ) : (
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
        side={variant === "topbar" ? "bottom" : "right"}
        align={variant === "topbar" ? "end" : "start"}
        sideOffset={8}
        className="w-[min(380px,calc(100vw-1rem))] max-h-[70dvh] flex flex-col p-0 gap-0"
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

