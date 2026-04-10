"use client";

/**
 * Active project context.
 *
 * Owns the "which project is the user looking at right now" state for the
 * whole app. Persists to localStorage so the selection survives reloads.
 * Consumed by:
 *   - <Shell> sidebar to highlight the active project and handle clicks
 *   - <BoardPage> / <RecurringPage> to scope their data queries
 *   - <TaskDialog> to pre-select the project on create
 *
 * The projectId/viewId state lives here so switching pages or opening a
 * dialog keeps the selection stable.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const STORAGE_KEY = "cyt:active";

type Persisted = {
  projectId: number | null;
  viewId: number | null;
};

type ActiveProjectContextValue = Persisted & {
  setProjectId: (id: number | null) => void;
  setViewId: (id: number | null) => void;
  hydrated: boolean;
};

const Ctx = createContext<ActiveProjectContextValue | null>(null);

function readStorage(): Persisted {
  if (typeof window === "undefined") {
    return { projectId: null, viewId: null };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { projectId: null, viewId: null };
    const parsed = JSON.parse(raw);
    return {
      projectId:
        typeof parsed?.projectId === "number" ? parsed.projectId : null,
      viewId: typeof parsed?.viewId === "number" ? parsed.viewId : null,
    };
  } catch {
    return { projectId: null, viewId: null };
  }
}

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  // Start with nulls on the server to avoid hydration mismatch; read from
  // localStorage after mount.
  const [projectId, setProjectIdState] = useState<number | null>(null);
  const [viewId, setViewIdState] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const persisted = readStorage();
    setProjectIdState(persisted.projectId);
    setViewIdState(persisted.viewId);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ projectId, viewId }),
      );
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [projectId, viewId, hydrated]);

  const setProjectId = useCallback((id: number | null) => {
    setProjectIdState(id);
    // Switching projects always resets the saved view selection.
    setViewIdState(null);
  }, []);

  const setViewId = useCallback((id: number | null) => {
    setViewIdState(id);
  }, []);

  return (
    <Ctx.Provider
      value={{ projectId, viewId, setProjectId, setViewId, hydrated }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useActiveProject(): ActiveProjectContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useActiveProject must be used inside <ActiveProjectProvider>",
    );
  }
  return ctx;
}
