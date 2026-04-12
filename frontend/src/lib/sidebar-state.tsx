"use client";

/**
 * Sidebar collapsed/expanded state. Persisted to localStorage so the
 * preference survives reloads. Same hydration-guard pattern as
 * active-project.tsx.
 *
 * The sidebar has three modes driven by viewport width:
 *   1. Desktop (≥1024px): inline, toggleable between expanded and collapsed
 *   2. Mobile  (<1024px):  hidden by default, opens as overlay with backdrop
 *
 * On desktop, "collapsed" means the narrow icon-only strip. On mobile,
 * "collapsed" means the overlay is closed.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const STORAGE_KEY = "cyt:sidebar";

type SidebarContextValue = {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
  /** True once client-side localStorage has been read. */
  hydrated: boolean;
};

const Ctx = createContext<SidebarContextValue | null>(null);

function readStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCollapsedState(readStorage());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed, hydrated]);

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((prev) => !prev);
  }, []);

  return (
    <Ctx.Provider value={{ collapsed, setCollapsed, toggle, hydrated }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useSidebar must be used inside <SidebarProvider>");
  }
  return ctx;
}
