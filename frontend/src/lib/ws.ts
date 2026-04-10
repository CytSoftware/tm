/**
 * Per-project WebSocket subscriber.
 *
 * We don't need a global singleton — React mounts one of these per project
 * view, the hook tears it down on unmount, and the browser reconnects with
 * exponential backoff if the connection drops.
 *
 * On every incoming event, we invalidate the task list cache for the project.
 * TanStack Query then refetches the visible view and the board re-renders.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TaskEvent } from "./types";
import { taskListKey, projectKey } from "./query-keys";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

type Options = {
  projectId: number;
  queryClient: QueryClient;
  onEvent?: (event: TaskEvent) => void;
};

export function connectProjectSocket({
  projectId,
  queryClient,
  onEvent,
}: Options): () => void {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: taskListKey(projectId) });
    queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
  }

  function connect() {
    if (disposed) return;
    socket = new WebSocket(`${WS_URL}/ws/projects/${projectId}/`);

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as TaskEvent;
        onEvent?.(data);
        if (data.type !== "connected") {
          invalidate();
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
