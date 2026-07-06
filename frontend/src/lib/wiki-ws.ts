/**
 * Global subscriber for the wiki page tree.
 *
 * One socket per mounted /wiki view. Carries only lightweight tree-shape
 * events (create / rename / move / delete) — body edits flow over the
 * per-document Yjs collab socket, not here.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { WikiEvent } from "./types";
import { wikiDocKey } from "./query-keys";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

type Options = {
  queryClient: QueryClient;
  onEvent?: (event: WikiEvent) => void;
};

export function connectWikiTreeSocket({
  queryClient,
  onEvent,
}: Options): () => void {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function invalidate(event: WikiEvent) {
    // Invalidate the whole wiki namespace (tree + any doc detail).
    queryClient.invalidateQueries({ queryKey: ["wiki"] });
    if ("key" in event) {
      queryClient.invalidateQueries({ queryKey: wikiDocKey(event.key) });
    }
  }

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${WS_URL}/ws/wiki/`);

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as WikiEvent;
        onEvent?.(data);
        if (data.type !== "connected") {
          invalidate(data);
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
