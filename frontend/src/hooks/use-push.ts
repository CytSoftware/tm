"use client";

/**
 * Web Push for this browser. On by default: `autoEnablePush` subscribes
 * silently when permission is already granted, and otherwise asks on the
 * first tap — browsers (iOS strictly) refuse a permission prompt that isn't
 * triggered by a user gesture. Turning it off in the Inbox is remembered so
 * we never re-subscribe behind the user's back.
 *
 * "unsupported" covers dev builds too: RegisterSW only registers /sw.js in
 * production, so `ready` never resolves. On iOS, PushManager only exists once
 * the app is added to the Home Screen.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";

const PUSH_URL = "/api/notifications/push/";
const OPT_OUT_KEY = "cyt-push-off";

export type PushState = "unsupported" | "off" | "on" | "denied";

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Subscribe (or reuse the existing subscription) and register it with the
 *  backend. Re-POSTing is idempotent and heals a lost server-side row. */
async function subscribe(): Promise<boolean> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { public_key } = await apiFetch<{ public_key: string }>(PUSH_URL);
    if (!public_key) return false;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(public_key),
    });
  }
  await apiFetch(PUSH_URL, { method: "POST", body: sub.toJSON() });
  return true;
}

let autoStarted = false;

/** Call once the user is signed in. Safe to call from several mounts. */
export function autoEnablePush() {
  if (autoStarted || !supported()) return;
  autoStarted = true;
  if (localStorage.getItem(OPT_OUT_KEY)) return;

  if (Notification.permission === "granted") {
    void subscribe().catch(() => {});
  } else if (Notification.permission === "default") {
    const ask = () => {
      void Notification.requestPermission()
        .then((p) => (p === "granted" ? subscribe() : false))
        .catch(() => {});
    };
    window.addEventListener("click", ask, { once: true, capture: true });
  }
}

/** Current state + toggle for the Inbox button. Mount it where it renders
 *  fresh (inside the popover) so it reflects what autoEnablePush did. */
export function usePush() {
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported()) return;
    let cancelled = false;
    void navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (cancelled) return;
      if (sub) setState("on");
      else setState(Notification.permission === "denied" ? "denied" : "off");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (state === "on") {
        localStorage.setItem(OPT_OUT_KEY, "1");
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await apiFetch(PUSH_URL, {
            method: "DELETE",
            body: { endpoint: sub.endpoint },
          });
          await sub.unsubscribe();
        }
        setState("off");
        return;
      }
      localStorage.removeItem(OPT_OUT_KEY);
      setState((await subscribe()) ? "on" : "off");
    } catch {
      setState(Notification.permission === "denied" ? "denied" : "off");
    } finally {
      setBusy(false);
    }
  }, [state]);

  return { state, busy, toggle };
}
