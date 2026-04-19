"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js on the client, in production only. Dev builds would churn
 * the SW on every rebuild and surface stale bundles; we avoid that entirely.
 */
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // PWA registration is best-effort; failures shouldn't break the app.
    });
  }, []);

  return null;
}
