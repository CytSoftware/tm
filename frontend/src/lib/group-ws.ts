/**
 * Reconnecting subscriber for a global Channels group (`ws/meetings/`,
 * `ws/crm/`, …) whose events are just "something changed": every message
 * other than the `connected` hello invalidates each of `roots` (top-level
 * query-key namespaces). Reconnects with exponential backoff, capped at 30s.
 *
 * Returns a disposer, so it drops straight into a `useEffect`.
 */

import type { QueryClient } from "@tanstack/react-query";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

export function connectGroupSocket(
  queryClient: QueryClient,
  /** Socket path, e.g. `/ws/crm/`. */
  path: string,
  /** Query-key roots to invalidate on every event. */
  roots: string[],
): () => void {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${WS_URL}${path}`);

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { type: string };
        if (data.type !== "connected") {
          for (const root of roots)
            queryClient.invalidateQueries({ queryKey: [root] });
        }
      } catch {
        // ignore malformed payloads
      }
    };

    socket.onclose = () => {
      if (disposed) return;
      reconnectAttempts += 1;
      const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts);
      reconnectTimer = setTimeout(connect, delay);
    };

    socket.onerror = () => {
      socket?.close();
    };
  }

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close();
    }
  };
}
