/**
 * Global subscriber for meetings.
 *
 * One socket per mounted /meetings view. Meetings span projects, so they have
 * their own `meetings` group instead of riding the per-project task socket.
 * Events are tiny (`{type, key}`); every one just invalidates the whole
 * ["meetings"] namespace — list, graph, facets and the open detail.
 */

import type { QueryClient } from "@tanstack/react-query";

import { connectGroupSocket } from "@/lib/group-ws";

export function connectMeetingsSocket(
  queryClient: QueryClient,
  /** Extra namespaces a meeting change affects (the CRM's "last contact"). */
  alsoInvalidate: string[] = [],
): () => void {
  return connectGroupSocket(queryClient, "/ws/meetings/", [
    "meetings",
    ...alsoInvalidate,
  ]);
}
