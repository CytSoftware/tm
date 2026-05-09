"use client";

/**
 * Left-rail sidebar — the permanent primary navigation surface for the app.
 *
 * Two responsive modes:
 *   Desktop (≥1024px): inline sidebar, toggleable between expanded (w-60)
 *     and collapsed (w-12, icon-only with tooltips). Toggle via button or ⌘B.
 *   Mobile (<1024px): sidebar is hidden off-screen, opened as an overlay
 *     with a backdrop via a hamburger button rendered by Shell.
 */

import { useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronsLeft,
  LayoutDashboard,
  LogOut,
  Settings,
  Star,
  Workflow,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { ModeToggle } from "./ModeToggle";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { meKey } from "@/lib/query-keys";
import { logout as apiLogout } from "@/lib/auth";
import { useSidebar } from "@/lib/sidebar-state";
import type { Me, User } from "@/lib/types";

// ────────────────────────────────────────────────────────────────────────
// Main Sidebar
// ────────────────────────────────────────────────────────────────────────

type SidebarProps = {
  user: User;
  /** Mobile overlay mode — renders full-width with close-on-navigate */
  mobile?: boolean;
  onClose?: () => void;
};

export function Sidebar({ user, mobile, onClose }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebar();

  const isCollapsed = mobile ? false : collapsed;

  return (
    <aside
      className={cn(
        "shrink-0 h-full flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out overflow-hidden",
        mobile ? "w-60" : isCollapsed ? "w-12" : "w-60",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "shrink-0 h-12 flex items-center border-b border-sidebar-border",
          isCollapsed ? "justify-center px-1" : "justify-between px-3",
        )}
      >
        {isCollapsed ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="size-8 rounded-md bg-foreground grid place-items-center text-background text-[11px] font-semibold"
                  onClick={toggle}
                  aria-label="Expand sidebar"
                >
                  C
                </button>
              }
            />
            <TooltipContent side="right">
              Expand sidebar <kbd className="ml-1 text-[10px]">⌘B</kbd>
            </TooltipContent>
          </Tooltip>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="size-6 rounded-md bg-foreground grid place-items-center text-background text-[11px] font-semibold">
                C
              </div>
              <span className="text-[13px] font-semibold tracking-tight">
                Cyt
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              {!mobile && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={toggle}
                        aria-label="Collapse sidebar"
                      >
                        <ChevronsLeft className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipContent side="right">
                    Collapse <kbd className="ml-1 text-[10px]">⌘B</kbd>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>

      {/* Scrollable nav list */}
      <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 py-2 space-y-1">
        <NavLink
          icon={
            <Star
              className={cn(
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground",
                pathname === "/focus" && "fill-amber-500 text-amber-500",
              )}
            />
          }
          label="My Focus"
          active={pathname === "/focus"}
          collapsed={isCollapsed}
          onNavigate={() => {
            if (pathname !== "/focus") router.push("/focus");
            onClose?.();
          }}
        />
        <NavLink
          icon={
            <LayoutDashboard
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Tasks"
          active={pathname.startsWith("/board")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/board");
            onClose?.();
          }}
        />
        <NavLink
          icon={
            <Workflow
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Pipelines"
          active={pathname.startsWith("/pipelines")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/pipelines");
            onClose?.();
          }}
        />
      </nav>

      {/* Footer: user + theme */}
      <div className="shrink-0 border-t border-sidebar-border p-1.5">
        <UserFooter user={user} collapsed={isCollapsed} />
      </div>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

function NavLink({
  icon,
  label,
  active,
  collapsed,
  onNavigate,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onNavigate}
              className={cn(
                "w-full grid place-items-center py-1.5 rounded-md transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
              )}
              aria-label={label}
            >
              {icon}
            </button>
          }
        />
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      onClick={onNavigate}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function UserFooter({
  user,
  collapsed,
}: {
  user: User;
  collapsed: boolean;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const avatarFileRef = useRef<HTMLInputElement | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const uploadAvatar = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("avatar_image", file);
      return apiFetch<Me>("/api/auth/me/", {
        method: "PATCH",
        body: form,
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(meKey(), data);
      qc.invalidateQueries({ queryKey: ["users"] });
      setAvatarError(null);
    },
    onError: (err) => {
      setAvatarError(err instanceof Error ? err.message : "Upload failed.");
    },
  });

  async function handleLogout() {
    try {
      await apiLogout();
    } finally {
      window.location.href = "/login";
    }
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="rounded-md p-1 hover:bg-sidebar-accent/60 transition-colors"
                onClick={() => router.push("/settings/staleness")}
                aria-label="Staleness settings"
              >
                <Settings className="size-4 text-muted-foreground" />
              </button>
            }
          />
          <TooltipContent side="right">Staleness settings</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="rounded-md p-1 hover:bg-sidebar-accent/60 transition-colors"
                onClick={handleLogout}
              >
                <UserAvatar
                  username={user.username}
                  avatarUrl={user.avatar_url}
                  size="size-6"
                />
              </button>
            }
          />
          <TooltipContent side="right">
            {user.username} — Click to log out
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex-1 flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sidebar-accent/60 transition-colors min-w-0"
            >
              <UserAvatar
                username={user.username}
                avatarUrl={user.avatar_url}
                size="size-6"
              />
              <span className="text-[12px] text-muted-foreground truncate">
                {user.username}
              </span>
            </button>
          }
        />
        <PopoverContent
          align="start"
          side="top"
          className="w-72 p-3 space-y-3"
        >
          <div className="flex items-center gap-3">
            <UserAvatar
              username={user.username}
              avatarUrl={user.avatar_url}
              size="size-8"
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium truncate">
                {user.username}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                {user.email}
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Avatar
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px] w-full"
              onClick={() => avatarFileRef.current?.click()}
              disabled={uploadAvatar.isPending}
            >
              {uploadAvatar.isPending ? "Uploading..." : "Upload image"}
            </Button>
            <input
              ref={avatarFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) uploadAvatar.mutate(file);
              }}
            />
            {avatarError && (
              <div className="text-[11px] text-destructive">
                {avatarError}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => router.push("/settings/staleness")}
              aria-label="Staleness settings"
            >
              <Settings className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>Staleness settings</TooltipContent>
      </Tooltip>
      <ModeToggle />
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={handleLogout}
        aria-label="Log out"
      >
        <LogOut className="size-3.5" />
      </Button>
    </div>
  );
}
