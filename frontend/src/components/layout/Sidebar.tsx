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

import { useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  BookText,
  ChevronsLeft,
  GitPullRequest,
  HardDrive,
  Home,
  LayoutDashboard,
  LogOut,
  Settings,
  Sparkles,
  Target,
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
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { ModeToggle } from "./ModeToggle";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { meKey } from "@/lib/query-keys";
import { logout as apiLogout } from "@/lib/auth";
import { useSidebar } from "@/lib/sidebar-state";
import { useActiveProject } from "@/lib/active-project";
import { useToReviewQuery } from "@/hooks/use-tasks";
import { useEventSourcesQuery } from "@/hooks/use-events";
import { MonitoringIcon } from "@/lib/monitoring";
import { QuickActionIcon } from "@/lib/quick-actions";
import type { Me, QuickAction, User } from "@/lib/types";

// ────────────────────────────────────────────────────────────────────────
// Main Sidebar
// ────────────────────────────────────────────────────────────────────────

type SidebarProps = {
  user: Me;
  /** Mobile overlay mode — renders full-width with close-on-navigate */
  mobile?: boolean;
  onClose?: () => void;
};

export function Sidebar({ user, mobile, onClose }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebar();
  const { projectId, setProjectId } = useActiveProject();

  const isCollapsed = mobile ? false : collapsed;

  const eventSourcesQuery = useEventSourcesQuery();
  const toReviewCount = useToReviewQuery().data?.length ?? 0;
  const quickActions = user.preferences.quick_actions ?? [];
  const monitoringSources = useMemo(
    () => eventSourcesQuery.data?.results ?? [],
    [eventSourcesQuery.data],
  );
  function openQuickAction(action: QuickAction) {
    if (action.kind === "project") {
      setProjectId(action.project_id);
      router.push(`/board?project=${action.project_id}`);
    } else if (action.kind === "assignee") {
      setProjectId(null);
      router.push(`/board?assignee=${action.user_id}`);
    } else if (/^https?:\/\//i.test(action.url)) {
      window.location.assign(action.url);
      return;
    } else {
      router.push(action.url);
    }
    onClose?.();
  }

  function quickActionActive(action: QuickAction) {
    if (action.kind === "project") {
      return pathname.startsWith("/board") && projectId === action.project_id;
    }
    if (action.kind === "page") {
      return pathname === action.url.split(/[?#]/, 1)[0];
    }
    return false;
  }

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
        {quickActions.length > 0 && (
          <SidebarGroup
            title="Quick actions"
            collapsed={isCollapsed}
            action={
              !isCollapsed && (
                <button
                  type="button"
                  onClick={() => {
                    router.push("/settings/quick-actions");
                    onClose?.();
                  }}
                  className="size-5 grid place-items-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
                  aria-label="Quick action settings"
                >
                  <Settings className="size-3" />
                </button>
              )
            }
          >
            {quickActions.map((action) => (
              <NavLink
                key={action.id}
                icon={
                  <QuickActionIcon
                    name={action.icon}
                    className={
                      isCollapsed
                        ? "size-4"
                        : "size-3.5 shrink-0 text-muted-foreground"
                    }
                  />
                }
                label={action.label}
                active={quickActionActive(action)}
                collapsed={isCollapsed}
                onNavigate={() => openQuickAction(action)}
              />
            ))}
          </SidebarGroup>
        )}
        <NotificationInbox collapsed={isCollapsed} onNavigate={onClose} />
        <NavLink
          icon={
            <Home
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Home"
          active={pathname === "/"}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/");
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
            <GitPullRequest
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="To Review"
          active={pathname.startsWith("/reviews")}
          collapsed={isCollapsed}
          badge={toReviewCount > 0 ? toReviewCount : undefined}
          onNavigate={() => {
            router.push("/reviews");
            onClose?.();
          }}
        />
        <NavLink
          icon={
            <Target
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Bets"
          active={pathname.startsWith("/bets")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/bets");
            onClose?.();
          }}
        />
        <NavLink
          icon={
            <BookText
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Wiki"
          active={pathname.startsWith("/wiki")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/wiki");
            onClose?.();
          }}
        />
        <NavLink
          icon={
            <HardDrive
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Drive"
          active={pathname.startsWith("/drive")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/drive");
            onClose?.();
          }}
        />
        <NavLink
          icon={
            <Sparkles
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="LLM Wiki"
          active={pathname.startsWith("/llm-wiki")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/llm-wiki");
            onClose?.();
          }}
        />

        {monitoringSources.length > 0 && (
          <SidebarGroup
            title="Monitoring"
            collapsed={isCollapsed}
            action={
              !isCollapsed && (
                <button
                  type="button"
                  onClick={() => {
                    router.push("/settings/incoming-webhooks");
                    onClose?.();
                  }}
                  className="size-5 grid place-items-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
                  aria-label="Monitoring settings"
                >
                  <Settings className="size-3" />
                </button>
              )
            }
          >
            {monitoringSources.map((source) => (
              <NavLink
                key={source.id}
                icon={
                  <MonitoringIcon
                    name={source.icon}
                    className={
                      isCollapsed
                        ? "size-4"
                        : "size-3.5 shrink-0 text-muted-foreground"
                    }
                  />
                }
                label={source.name}
                active={pathname === `/monitoring/${source.id}`}
                collapsed={isCollapsed}
                onNavigate={() => {
                  router.push(`/monitoring/${source.id}`);
                  onClose?.();
                }}
              />
            ))}
          </SidebarGroup>
        )}

        {/* Analytics is intentionally separated from the everyday workspace
            links. It stays easy to find without competing with Tasks or Bets
            for primary-navigation attention. */}
        <SidebarGroup title="Insights" collapsed={isCollapsed}>
          <NavLink
            icon={
              <BarChart3
                className={
                  isCollapsed
                    ? "size-4"
                    : "size-3.5 shrink-0 text-muted-foreground"
                }
              />
            }
            label="Analytics"
            active={pathname.startsWith("/analytics")}
            collapsed={isCollapsed}
            onNavigate={() => {
              router.push("/analytics");
              onClose?.();
            }}
          />
        </SidebarGroup>
      </nav>

      {/* Footer: user + theme */}
      <div className="shrink-0 border-t border-sidebar-border p-1.5">
        <UserFooter user={user} collapsed={isCollapsed} />
      </div>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Navigation sections
// ────────────────────────────────────────────────────────────────────────

function SidebarGroup({
  title,
  collapsed,
  action,
  children,
}: {
  title: string;
  collapsed: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-3">
      {collapsed ? (
        <div className="h-px bg-sidebar-border/60 mx-2 mb-1" aria-hidden />
      ) : (
        <div className="flex items-center gap-1 px-2 py-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {title}
          </span>
          <span className="ml-auto">{action}</span>
        </div>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
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
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
  /** Optional count rendered after the label (expanded mode only). */
  badge?: React.ReactNode;
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
      {badge != null && (
        <span className="ml-auto shrink-0 rounded-full bg-sidebar-accent px-1.5 text-[10.5px] tabular-nums text-sidebar-foreground/70">
          {badge}
        </span>
      )}
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
                onClick={() => router.push("/settings/quick-actions")}
                aria-label="Settings"
              >
                <Settings className="size-4 text-muted-foreground" />
              </button>
            }
          />
          <TooltipContent side="right">Settings</TooltipContent>
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
              onClick={() => router.push("/settings/quick-actions")}
              aria-label="Settings"
            >
              <Settings className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>Settings</TooltipContent>
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
