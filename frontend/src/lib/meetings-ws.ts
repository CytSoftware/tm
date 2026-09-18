/**
 * Global subscriber for meetings.
 *
 * One socket per mounted /meetings view. Meetings span projects, so they have
 * their own `meetings` group instead of riding the per-project task socket.
 * Events are tiny (`{type, key}`); every one just invalidates the whole
 * ["meetings"] namespace — list, graph, facets and the open detail.
 */

import type { QueryClient } from "@tanstack/react-query";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

export function connectMeetingsSocket(queryClient: QueryClient): () => void {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${WS_URL}/ws/meetings/`);

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { type: string };
        if (data.type !== "connected") {
          queryClient.invalidateQueries({ queryKey: ["meetings"] });
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
