"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Returns false on the server snapshot and true after mount — prevents
 *  hydration mismatches when gating client-only Yjs init. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
