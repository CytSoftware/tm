"use client";

/**
 * Dashboard activity feed — the same per-user notification stream as the
 * sidebar inbox popover, rendered on the page. Shares the popover's query
 * key, so the global notification socket's prepends and the 60s poll keep
 * both in sync for free.
 */

import { useMemo } from "react";
import { Bell, CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import {
  unreadCountFrom,
  useMarkAllNotificationsRead,
  useNotificationsInfinite,
} from "@/hooks/use-notifications";

export function ActivityFeed() {
  const query = useNotificationsInfinite();
  const markAllRead = useMarkAllNotificationsRead();

  const notifications = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.results),
    [query.data],
  );
  const unreadCount = unreadCountFrom(query.data);

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Bell className="size-3" />
        Activity
        {unreadCount > 0 && (
          <span className="tabular-nums normal-case tracking-normal">
            · {unreadCount} unread
          </span>
        )}
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-5 px-1.5 text-[10px] normal-case tracking-normal"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
          >
            <CheckCheck className="size-3" />
            Mark all read
          </Button>
        )}
      </h2>

      <div className="rounded-lg border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
        {query.isLoading ? (
          <div className="grid place-items-center py-12">
            <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-10 px-6 text-center text-[12px] text-muted-foreground">
            You&apos;re all caught up.
          </div>
        ) : (
          <>
            {notifications.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onNavigated={() => {}}
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
          </>
        )}
      </div>
    </section>
  );
}
