"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { meKey } from "@/lib/query-keys";
import { fetchMe } from "@/lib/auth";
import { ensureCsrfCookie } from "@/lib/api";
import { useSidebar } from "@/lib/sidebar-state";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Sidebar } from "./Sidebar";

/**
 * App shell.
 *
 * Layout:
 *   Desktop (≥1024px):
 *     <div class="h-screen flex">
 *       <Sidebar />                  ← inline, toggleable width
 *       <main class="flex-1 min-w-0">
 *
 *   Mobile (<1024px):
 *     <div class="h-screen flex flex-col">
 *       <TopBar with hamburger />
 *       <main class="flex-1 min-h-0">
 *     Sidebar renders as overlay with backdrop when open.
 */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const { toggle } = useSidebar();

  // Mobile overlay state (not persisted — always starts closed)
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile overlay on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    ensureCsrfCookie().catch(() => {});
  }, []);

  // ⌘B / Ctrl+B toggle
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        if (isDesktop) {
          toggle();
        } else {
          setMobileOpen((v) => !v);
        }
      }
    },
    [isDesktop, toggle],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const meQuery = useQuery({
    queryKey: meKey(),
    queryFn: fetchMe,
  });

  const needsLogin =
    !meQuery.isLoading && (meQuery.data === null || meQuery.isError);

  useEffect(() => {
    if (needsLogin && pathname !== "/login") {
      router.replace("/login");
    }
  }, [needsLogin, pathname, router]);

  if (pathname === "/login") return <>{children}</>;

  if (meQuery.isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (needsLogin || !meQuery.data) return null;

  const user = meQuery.data;

  // ── Desktop layout ──────────────────────────────────────────────────
  if (isDesktop) {
    return (
      <div className="h-screen flex overflow-hidden">
        <Sidebar user={user} />
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background">
          {children}
        </main>
      </div>
    );
  }

  // ── Mobile layout ───────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Thin mobile top-bar with hamburger */}
      <header className="shrink-0 h-11 flex items-center gap-2 px-3 border-b border-border/80 bg-background">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setMobileOpen(true)}
          aria-label="Open sidebar"
        >
          <Menu className="size-4" />
        </Button>
        <div className="flex items-center gap-1.5">
          <div className="size-5 rounded-[4px] bg-foreground grid place-items-center text-background text-[9px] font-semibold">
            C
          </div>
          <span className="text-[13px] font-semibold tracking-tight">
            Cyt
          </span>
        </div>
      </header>

      <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
        {children}
      </main>

      {/* Overlay sidebar */}
      {mobileOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50 transition-opacity"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          {/* Sidebar panel */}
          <div className="fixed inset-y-0 left-0 z-50 w-60 animate-in slide-in-from-left duration-200">
            <Sidebar
              user={user}
              mobile
              onClose={() => setMobileOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
}
