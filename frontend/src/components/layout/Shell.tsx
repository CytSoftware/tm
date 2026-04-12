"use client";

import { ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { meKey } from "@/lib/query-keys";
import { fetchMe } from "@/lib/auth";
import { ensureCsrfCookie } from "@/lib/api";
import { Sidebar } from "./Sidebar";

/**
 * App shell.
 *
 * Layout:
 *
 *   <div class="h-screen flex">      ← horizontal: sidebar + main
 *     <Sidebar />                    ← full-height left rail
 *     <main class="flex-1 min-w-0">  ← page content
 *       {children}
 *
 * The sidebar owns user menu, theme toggle, and primary nav (projects, views).
 * Each page owns its own thin in-column header for page-specific controls.
 *
 * Respects the no-page-scroll invariant from app/layout.tsx: the root is
 * h-screen with overflow hidden on the body; the main column has min-w-0 so
 * flex children with horizontal scrollers shrink correctly.
 */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    ensureCsrfCookie().catch(() => {});
  }, []);

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

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar user={meQuery.data} />
      <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background">
        {children}
      </main>
    </div>
  );
}
