"use client";

import * as React from "react";

export type WikiPageRef = { key: string; title: string };

type WikiNavContextValue = {
  /** Navigate to a wiki page by its string key, e.g. "DOC-001". */
  onNavigate: (pageKey: string) => void;
  /** Live list of selectable pages (the wiki tree), for the combobox. */
  pages: WikiPageRef[];
};

const WikiNavContext = React.createContext<WikiNavContextValue | null>(null);

export function WikiNavProvider({
  onNavigate,
  pages,
  children,
}: WikiNavContextValue & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ onNavigate, pages }),
    [onNavigate, pages],
  );
  return (
    <WikiNavContext.Provider value={value}>{children}</WikiNavContext.Provider>
  );
}

export function useWikiNav(): WikiNavContextValue {
  const ctx = React.useContext(WikiNavContext);
  // Tolerate render outside a provider (e.g. SSR) — the chip just won't navigate.
  return ctx ?? { onNavigate: () => {}, pages: [] };
}
