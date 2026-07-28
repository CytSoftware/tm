"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Returns `true` when the query matches.
 * Server-renders as `false` and hydrates on mount to avoid mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** The `lg` breakpoint, i.e. the `max-lg:` / `lg:` boundary used throughout. */
const MOBILE_QUERY = "(max-width: 1023px)";

/**
 * Structural mobile check, for the handful of places where the DOM genuinely
 * has to differ rather than just restyle (the board's column pager, the move
 * sheet, the task panel body). **Prefer `max-lg:` classes** — CSS costs no
 * hydration round-trip and can't flash.
 *
 * `hydrated` is false during SSR and the first client render. Callers should
 * render the desktop tree until it flips, otherwise a desktop browser paints
 * the mobile layout first and swaps — which is exactly the bug the Shell had
 * before TAS-061.
 */
export function useIsMobile(): { isMobile: boolean; hydrated: boolean } {
  const [state, setState] = useState({ isMobile: false, hydrated: false });

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    setState({ isMobile: mql.matches, hydrated: true });
    const handler = (e: MediaQueryListEvent) =>
      setState({ isMobile: e.matches, hydrated: true });
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return state;
}

/**
 * True on touch-primary devices. Used to turn off affordances that only work
 * with a mouse — chiefly the native HTML5 drag the board relies on, which
 * never fires from touch but still arms the iOS long-press callout.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
