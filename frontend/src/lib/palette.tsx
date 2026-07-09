"use client";

/**
 * Unified ⌘K palette state. The palette itself (components/CommandPalette.tsx)
 * is mounted once in the Shell so search + commands work on every page; this
 * context lets the active page contribute page-specific pieces — the board
 * registers its selected task (which unlocks task-scoped actions) and the
 * commands that open board-mounted dialogs (create project / create label).
 * Open/close state lives here too so the Shell's ⌘K handler and the board's
 * keydown guard read the same source of truth.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { Task } from "@/lib/types";

export type PaletteAction = {
  id: string;
  label: string;
  /** Additional keywords for fuzzy matching */
  keywords?: string;
  handler: () => void;
};

export type PalettePageContext = {
  /** Task the palette should scope its command list to (board selection). */
  selectedTask: Task | null;
  /** Page-specific commands (e.g. ones that open page-mounted dialogs). */
  extraActions: PaletteAction[];
};

type PaletteContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  pageContext: PalettePageContext | null;
  setPageContext: (ctx: PalettePageContext | null) => void;
};

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pageContext, setPageContext] = useState<PalettePageContext | null>(
    null,
  );
  const value = useMemo(
    () => ({ open, setOpen, pageContext, setPageContext }),
    [open, pageContext],
  );
  return (
    <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>
  );
}

export function usePalette(): PaletteContextValue {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error("usePalette must be used within PaletteProvider");
  return ctx;
}

/** Keep the palette's page context in sync with the calling page. Pass a
 *  memoized value — this re-registers on every identity change — and the
 *  registration is dropped automatically when the page unmounts. */
export function usePalettePageContext(ctx: PalettePageContext) {
  const { setPageContext } = usePalette();
  useEffect(() => {
    setPageContext(ctx);
  }, [ctx, setPageContext]);
  useEffect(() => () => setPageContext(null), [setPageContext]);
}
