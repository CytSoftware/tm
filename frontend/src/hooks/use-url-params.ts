"use client";

/**
 * URL-as-state helpers for pages whose whole view (tab, filters, open record)
 * lives in the query string, so any state is a shareable link and the back
 * button walks through it. Callers need a Suspense boundary (useSearchParams).
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type SetParams = (
  patch: Record<string, string | null>,
  opts?: { push?: boolean },
) => void;

/** The current search params plus a patcher: `null` / `""` deletes a key. */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setParams: SetParams = useCallback(
    (patch, opts) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      // Opening a record is a navigation (back closes it); tweaking a filter isn't.
      if (opts?.push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [params, pathname, router],
  );

  return { params, setParams };
}

/**
 * A search box whose value is local state, debounced into the URL (`?q=`).
 * `search` / `setSearch` drive the input; `urlSearch` is the committed value
 * to filter on.
 */
export function useUrlSearch(
  params: Pick<URLSearchParams, "get">,
  setParams: SetParams,
  key = "q",
) {
  const urlSearch = params.get(key) ?? "";
  const [search, setSearch] = useState(urlSearch);
  // Follow the URL when it changes underneath us (back button, shared link)
  // — but not when the change is just our own debounced write landing.
  // `router.replace` is async: without this guard, a character typed while it
  // is in flight would be overwritten by the older value coming back.
  const [sync, setSync] = useState({ seen: urlSearch, sent: urlSearch });
  if (sync.seen !== urlSearch) {
    setSync({ seen: urlSearch, sent: urlSearch });
    if (urlSearch !== sync.sent) setSearch(urlSearch);
  }
  useEffect(() => {
    const next = search.trim();
    if (next === urlSearch) return;
    const t = setTimeout(() => {
      setSync((s) => ({ ...s, sent: next }));
      setParams({ [key]: next || null });
    }, 250);
    return () => clearTimeout(t);
  }, [search, urlSearch, setParams, key]);

  return { urlSearch, search, setSearch };
}
