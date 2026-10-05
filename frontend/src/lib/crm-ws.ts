/**
 * Global subscriber for the CRM.
 *
 * One socket per mounted /crm view, on the `crm` group (contacts, deals,
 * touchpoints, pipelines, follow-up changes made through the CRM). Events are
 * tiny; every one just invalidates the whole ["crm"] namespace. Meeting
 * events matter too — a new recording moves a contact's "last contact" — so
 * the page also mounts the meetings socket.
 */

import type { QueryClient } from "@tanstack/react-query";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

export function connectCrmSocket(queryClient: QueryClient): () => void {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${WS_URL}/ws/crm/`);

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { type: string };
        if (data.type !== "connected") {
          queryClient.invalidateQueries({ queryKey: ["crm"] });
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
