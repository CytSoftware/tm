"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, Search as SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CommandPalette } from "@/components/CommandPalette";
import { GlobalShortcuts } from "@/components/GlobalShortcuts";
import { meKey, myTasksKey, toReviewKey } from "@/lib/query-keys";
import { fetchMe } from "@/lib/auth";
import { ensureCsrfCookie } from "@/lib/api";
import { connectNotificationSocket } from "@/lib/ws";
import { usePalette } from "@/lib/palette";
import { useSidebar } from "@/lib/sidebar-state";
import { TaskDialogProvider } from "@/lib/task-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { prependNotification } from "@/hooks/use-notifications";
import { Sidebar } from "./Sidebar";

/**
 * App shell.
 *
 * One DOM, switched by CSS at `lg` (1024px):
 *   ≥lg   <Sidebar> inline (toggleable width), mobile top-bar hidden
 *   <lg   top-bar with hamburger, <Sidebar> in a left Sheet
 *
 * This used to branch in JS on `useMediaQuery("(min-width: 1024px)")`, which
 * server-renders `false` — so *every* device, desktop included, painted the
 * mobile layout and swapped on hydration. Keep it CSS-only (TAS-061).
 */
/**
 * Routes that render without the app chrome.
 *
 * `/login` is the obvious one. `/oauth/consent` joins it because it is a step
 * inside another application's OAuth flow: showing the sidebar and project
 * switcher there would invite the user to wander off mid-authorization, and the
 * page is reached by redirect from the backend rather than by navigation.
 */
const STANDALONE_ROUTES = ["/login", "/oauth/consent"];

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { toggle } = useSidebar();
  const queryClient = useQueryClient();

  // Mobile overlay state (not persisted — always starts closed)
  const [mobileOpen, setMobileOpen] = useState(false);
  // Unified command palette overlay (Cmd/Ctrl+K) — commands + search. Open
  // state lives in PaletteContext so the board's keydown guard sees it too.
  const { open: paletteOpen, setOpen: setPaletteOpen } = usePalette();

  // Close mobile overlay on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Close the palette on navigation — result clicks already close it, but
  // this also covers sidebar clicks behind the backdrop etc.
  useEffect(() => {
    setPaletteOpen(false);
  }, [pathname, setPaletteOpen]);

  useEffect(() => {
    ensureCsrfCookie().catch(() => {});
  }, []);

  // Keyboard shortcuts:
  //   ⌘B / Ctrl+B  toggle sidebar
  //   ⌘K / Ctrl+K  toggle the command palette
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        // Read the breakpoint at press time rather than holding it in state —
        // the layout itself is CSS-only, so there's nothing to subscribe to.
        if (window.matchMedia("(min-width: 1024px)").matches) {
          toggle();
        } else {
          setMobileOpen((v) => !v);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }
    },
    [toggle, paletteOpen, setPaletteOpen],
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
    if (!needsLogin || pathname === "/login") return;
    // `/oauth/consent` carries the whole authorization request in its query
    // string, so bouncing to a bare `/login` would silently discard it and the
    // waiting client would hang. Round-trip it through `next` instead.
    if (pathname === "/oauth/consent") {
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    router.replace("/login");
  }, [needsLogin, pathname, router]);

  // Global notification socket — one per authenticated session, mounted
  // here (not per project view like connectProjectSocket). Keyed on user id
  // rather than the `meQuery.data` object so a background refetch of `/me`
  // doesn't tear down and reconnect the socket.
  const userId = meQuery.data?.id ?? null;
  useEffect(() => {
    if (needsLogin || userId == null) return;
    return connectNotificationSocket({
      // `event` carries an extra `type` discriminant beyond `Notification`'s
      // fields — fine to pass through structurally, no need to destructure
      // it off first.
      onNotification: (event) => {
        prependNotification(queryClient, event);
        // A notification addressed to me almost always means my task list
        // changed (assigned/moved/completed/deleted) — refresh the
        // dashboard inbox and the To Review page, which have no project
        // socket of their own. Caveat: notify_task_event recipients default
        // to assignees, so a reviewer who isn't also an assignee gets no
        // notification and relies on the queries' 60s poll instead.
        queryClient.invalidateQueries({ queryKey: myTasksKey() });
        queryClient.invalidateQueries({ queryKey: toReviewKey() });
      },
    });
  }, [needsLogin, userId, queryClient]);

  if (STANDALONE_ROUTES.includes(pathname)) return <>{children}</>;

  if (meQuery.isLoading) {
    return (
      <div className="h-dvh flex items-center justify-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (needsLogin || !meQuery.data) return null;

  const user = meQuery.data;

  return (
    <TaskDialogProvider>
      <GlobalShortcuts />
      <div className="h-dvh flex flex-col lg:flex-row overflow-hidden">
        {/* Inline sidebar — desktop only */}
        <div className="hidden lg:flex shrink-0">
          <Sidebar user={user} />
        </div>

        {/* Top-bar with hamburger — mobile only */}
        {/* `min-h` + `pt-safe` rather than a fixed `h`: under viewport-fit=cover
            the bar has to grow by the status-bar inset, not squash into it. */}
        <header className="lg:hidden shrink-0 min-h-12 pt-safe flex items-center gap-2 px-2 border-b border-border/80 bg-background">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 tap-target"
            onClick={() => setMobileOpen(true)}
            aria-label="Open sidebar"
          >
            <Menu className="size-4" />
          </Button>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <div className="size-5 rounded-[4px] bg-foreground grid place-items-center text-background text-[9px] font-semibold">
              C
            </div>
            <span className="text-[13px] font-semibold tracking-tight">
              Cyt
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 tap-target"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
          >
            <SearchIcon className="size-4" />
          </Button>
        </header>

        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background">
          {children}
        </main>

        {/* Nav drawer — mobile only. The Sheet brings the focus trap, scroll
            lock and Escape handling the old hand-rolled overlay lacked. */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-60 bg-sidebar"
            showHandle={false}
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Sidebar
              user={user}
              mobile
              onClose={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </TaskDialogProvider>
  );
}
