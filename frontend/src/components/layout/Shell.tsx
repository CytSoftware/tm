"use client";

import { ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";

import { meKey } from "@/lib/query-keys";
import { fetchMe, logout as apiLogout } from "@/lib/auth";
import { apiFetch, ensureCsrfCookie } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  const qc = useQueryClient();
  const [avatarInput, setAvatarInput] = useState(user.avatar_url || "");

  const updateAvatar = useMutation({
    mutationFn: (url: string) =>
      apiFetch<User>("/api/auth/me/", {
        method: "PATCH",
        body: { avatar_url: url },
      }),
    onSuccess: (data) => {
      qc.setQueryData(meKey(), data);
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

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
        <Popover>
          <PopoverTrigger
            render={
              <button type="button" className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent transition-colors">
                <UserAvatar
                  username={user.username}
                  avatarUrl={user.avatar_url}
                  size="size-6"
                />
                <span className="text-[12px] text-muted-foreground">
                  {user.username}
                </span>
              </button>
            }
          />
          <PopoverContent align="end" className="w-72 p-3 space-y-3">
            <div className="flex items-center gap-3">
              <UserAvatar
                username={user.username}
                avatarUrl={user.avatar_url}
                size="size-8"
              />
              <div>
                <div className="text-[13px] font-medium">{user.username}</div>
                <div className="text-[11px] text-muted-foreground">{user.email}</div>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Avatar URL
              </span>
              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  updateAvatar.mutate(avatarInput);
                }}
              >
                <Input
                  value={avatarInput}
                  onChange={(e) => setAvatarInput(e.target.value)}
                  placeholder="https://..."
                  className="h-7 text-[12px]"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={updateAvatar.isPending}
                >
                  Save
                </Button>
              </form>
            </div>
          </PopoverContent>
        </Popover>
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
