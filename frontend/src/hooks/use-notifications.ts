"use client";

/**
 * Notification inbox queries + mutations.
 *
 * The list endpoint is the single source of truth for both the row data and
 * the unread badge count (`unread_count` is piggybacked onto every list
 * response — see `NotificationViewSet.list`). We still poll it on an
 * interval as a WebSocket fallback (`connectNotificationSocket` in ws.ts
 * covers the live path; this covers missed/dropped-connection gaps).
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { notificationsKey } from "@/lib/query-keys";
import type { Notification, NotificationListResponse } from "@/lib/types";

const NOTIFICATIONS_URL = "/api/notifications/";
const PAGE_SIZE = 20;
/** WS fallback poll — the socket covers the live path, this just bounds
 *  staleness if a connection silently drops without a close event. */
const UNREAD_POLL_MS = 60_000;

export function useNotificationsInfinite() {
  return useInfiniteQuery<NotificationListResponse>({
    queryKey: notificationsKey(),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<NotificationListResponse>(NOTIFICATIONS_URL, {
        query: { limit: PAGE_SIZE, offset: pageParam as number },
      }),
    getNextPageParam: (last, pages) => {
      if (!last.next) return undefined;
      return pages.reduce((n, p) => n + p.results.length, 0);
    },
    refetchInterval: UNREAD_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Unread count from the most recently fetched page-1 response, or 0 before
 *  the first fetch resolves. */
export function unreadCountFrom(
  data: InfiniteData<NotificationListResponse> | undefined,
): number {
  return data?.pages[0]?.unread_count ?? 0;
}

function patchNotification(
  qc: ReturnType<typeof useQueryClient>,
  id: number,
  patch: Partial<Notification>,
) {
  qc.setQueryData<InfiniteData<NotificationListResponse>>(
    notificationsKey(),
    (data) => {
      if (!data) return data;
      let unreadDelta = 0;
      const pages = data.pages.map((page) => {
        let pageChanged = false;
        const results = page.results.map((n) => {
          if (n.id !== id) return n;
          if (
            patch.read_at !== undefined &&
            n.read_at === null &&
            patch.read_at !== null
          ) {
            unreadDelta -= 1;
          }
          pageChanged = true;
          return { ...n, ...patch };
        });
        return pageChanged ? { ...page, results } : page;
      });
      if (unreadDelta === 0) return { ...data, pages };
      return {
        ...data,
        pages: pages.map((page, i) =>
          i === 0
            ? { ...page, unread_count: Math.max(0, page.unread_count + unreadDelta) }
            : page,
        ),
      };
    },
  );
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Notification>(`${NOTIFICATIONS_URL}${id}/read/`, {
        method: "POST",
      }),
    onMutate: (id) => {
      const nowIso = new Date().toISOString();
      patchNotification(qc, id, { read_at: nowIso });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: notificationsKey() }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ updated: number }>(`${NOTIFICATIONS_URL}read_all/`, {
        method: "POST",
      }),
    onMutate: () => {
      const nowIso = new Date().toISOString();
      qc.setQueryData<InfiniteData<NotificationListResponse>>(
        notificationsKey(),
        (data) => {
          if (!data) return data;
          return {
            ...data,
            pages: data.pages.map((page, i) => ({
              ...page,
              unread_count: i === 0 ? 0 : page.unread_count,
              results: page.results.map((n) =>
                n.read_at === null ? { ...n, read_at: nowIso } : n,
              ),
            })),
          };
        },
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: notificationsKey() }),
  });
}

/** Prepend a freshly-arrived WS notification to the cached first page and
 *  bump the unread count. Falls back to a plain invalidate if the list
 *  hasn't been fetched yet (nothing to prepend into). */
export function prependNotification(
  qc: ReturnType<typeof useQueryClient>,
  notification: Notification,
) {
  const existing = qc.getQueryData<InfiniteData<NotificationListResponse>>(
    notificationsKey(),
  );
  if (!existing || existing.pages.length === 0) {
    qc.invalidateQueries({ queryKey: notificationsKey() });
    return;
  }
  // Avoid duplicates if a refetch already picked this row up.
  const alreadyPresent = existing.pages.some((page) =>
    page.results.some((n) => n.id === notification.id),
  );
  if (alreadyPresent) return;

  qc.setQueryData<InfiniteData<NotificationListResponse>>(
    notificationsKey(),
    (data) => {
      if (!data) return data;
      return {
        ...data,
        pages: data.pages.map((page, i) =>
          i === 0
            ? {
                ...page,
                results: [notification, ...page.results],
                count: page.count + 1,
                unread_count: page.unread_count + 1,
              }
            : page,
        ),
      };
    },
  );
}
