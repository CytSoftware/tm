"use client";

/**
 * A `y-websocket` provider wrapped as a Plate `UnifiedProvider`, and registered
 * as the `"websocket"` provider type.
 *
 * `@platejs/yjs` ships built-in provider types for hocuspocus / webrtc /
 * indexeddb only. We run a plain Yjs websocket server (in Django Channels via
 * pycrdt), so we register our own type. Plate constructs it with the shared
 * Y.Doc + Awareness, so y-websocket binds to Plate's document.
 */

import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { registerProviderType, type UnifiedProvider } from "@platejs/yjs";

type WsOptions = { url: string; name: string };

type WrapperProps = {
  options: WsOptions;
  doc?: Y.Doc;
  awareness?: Awareness;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onSyncChange?: (isSynced: boolean) => void;
};

class WebsocketUnifiedProvider implements UnifiedProvider {
  type = "websocket";
  document: Y.Doc;
  awareness: Awareness;
  isConnected = false;
  isSynced = false;
  isConnectionPending = true;
  isSyncPending = true;
  private provider: WebsocketProvider;

  constructor({
    options,
    doc,
    awareness,
    onConnect,
    onDisconnect,
    onError,
    onSyncChange,
  }: WrapperProps) {
    if (!doc || !awareness) {
      throw new Error("websocket provider requires a shared doc + awareness");
    }
    this.document = doc;
    this.awareness = awareness;
    // connect:false — Plate drives connect()/disconnect() lifecycle.
    this.provider = new WebsocketProvider(options.url, options.name, doc, {
      awareness,
      connect: false,
    });

    this.provider.on("status", (event: { status: string }) => {
      this.isConnected = event.status === "connected";
      this.isConnectionPending = event.status === "connecting";
      if (event.status === "connected") onConnect?.();
      else if (event.status === "disconnected") onDisconnect?.();
    });
    this.provider.on("sync", (isSynced: boolean) => {
      this.isSynced = isSynced;
      this.isSyncPending = !isSynced;
      onSyncChange?.(isSynced);
    });
    this.provider.on("connection-error", () => {
      onError?.(new Error("wiki collaboration websocket error"));
    });
  }

  connect() {
    this.provider.connect();
  }
  disconnect() {
    this.provider.disconnect();
  }
  destroy() {
    this.provider.destroy();
  }
}

let registered = false;

/** Idempotently register the `"websocket"` Yjs provider type. */
export function ensureWebsocketProviderRegistered(): void {
  if (registered) return;
  registered = true;
  registerProviderType(
    "websocket",
    WebsocketUnifiedProvider as unknown as Parameters<
      typeof registerProviderType
    >[1],
  );
}
