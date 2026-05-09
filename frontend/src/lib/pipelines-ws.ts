/**
 * Single global subscriber for the pipelines board.
 *
 * Pipelines live on one shared kanban (no per-board scoping in v1) so we
 * connect to one socket and invalidate the pipelines list on every event.
 * Mirrors lib/ws.ts but scoped to pipelines.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { PipelineEvent } from "./types";
import {
  pipelineKey as pKey,
  pipelineEventsKey,
} from "./query-keys";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

type Options = {
  queryClient: QueryClient;
  onEvent?: (event: PipelineEvent) => void;
};

export function connectPipelineSocket({
  queryClient,
  onEvent,
}: Options): () => void {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function invalidate(event: PipelineEvent) {
    // Invalidate the entire pipelines list cache (any filter combination).
    queryClient.invalidateQueries({ queryKey: ["pipelines"] });
    if ("key" in event) {
      queryClient.invalidateQueries({ queryKey: pKey(event.key) });
      queryClient.invalidateQueries({ queryKey: pipelineEventsKey(event.key) });
    }
  }

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${WS_URL}/ws/pipelines/`);

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as PipelineEvent;
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
