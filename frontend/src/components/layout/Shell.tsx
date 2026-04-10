"use client";

import { ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { LogOut } from "lucide-react";

import { meKey } from "@/lib/query-keys";
import { fetchMe, logout as apiLogout } from "@/lib/auth";
import { ensureCsrfCookie } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/UserAvatar";
import { ModeToggle } from "./ModeToggle";

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
    <div className="h-screen flex flex-col overflow-hidden">
      <TopNav user={meQuery.data} />
      <main className="flex-1 min-h-0 overflow-hidden bg-background">
        {children}
      </main>
    </div>
  );
}

function TopNav({ user }: { user: User }) {
  async function handleLogout() {
    try {
      await apiLogout();
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <header className="shrink-0 h-12 flex items-center justify-between px-4 border-b border-border/80 bg-background">
      <div className="flex items-center gap-2">
        <div className="size-6 rounded-md bg-foreground grid place-items-center text-background text-[11px] font-semibold">
          C
        </div>
        <span className="text-[13px] font-semibold tracking-tight">Cyt</span>
      </div>
      <div className="flex items-center gap-1">
        <ModeToggle />
        <div className="mx-1 h-5 w-px bg-border" />
        <UserAvatar username={user.username} size="size-6" />
        <span className="text-[12px] text-muted-foreground px-1">
          {user.username}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={handleLogout}
          aria-label="Log out"
        >
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}
