"use client";

/**
 * Left-rail sidebar — the permanent primary navigation surface for the app.
 *
 * Two responsive modes:
 *   Desktop (≥1024px): inline sidebar, toggleable between expanded (w-60)
 *     and collapsed (w-12, icon-only with tooltips). Toggle via button or ⌘B.
 *   Mobile (<1024px): sidebar is hidden off-screen, opened as an overlay
 *     with a backdrop via a hamburger button rendered by Shell.
 *
 * Sections (v1):
 *   1. Starred projects (only rendered when the user has stars)
 *   2. Projects — non-archived, non-starred (with a "show archived" toggle)
 *   3. Views — saved views (flat list)
 */

import { useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Layers,
  LayoutGrid,
  List,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Star,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { NewViewDialog } from "@/components/views/ViewSwitcher";
import { ModeToggle } from "./ModeToggle";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { meKey, viewsKey } from "@/lib/query-keys";
import { logout as apiLogout } from "@/lib/auth";
import { useActiveProject } from "@/lib/active-project";
import { useSidebar } from "@/lib/sidebar-state";
import {
  useProjectsQuery,
  useStarProject,
  useUnstarProject,
  useDeleteProject,
} from "@/hooks/use-projects";
import type {
  Project,
  SavedView,
  User,
  ViewListResponse,
} from "@/lib/types";

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
  const qc = useQueryClient();
  const { projectId, viewId, setProjectId, setViewId } = useActiveProject();
  const { collapsed, toggle } = useSidebar();

  // In mobile overlay mode, sidebar is always expanded
  const isCollapsed = mobile ? false : collapsed;

  const projectsQuery = useProjectsQuery();

  const viewsQuery = useQuery({
    queryKey: viewsKey(),
    queryFn: () => apiFetch<ViewListResponse>("/api/views/"),
  });
  const allViews: SavedView[] = viewsQuery.data?.results ?? [];

  const deleteView = useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/views/${id}/`, { method: "DELETE" }),
    onSuccess: (_data, deletedId) => {
      qc.invalidateQueries({ queryKey: viewsKey() });
      if (viewId === deletedId) setViewId(null);
    },
  });

  const { starred, ongoing, archived } = useMemo(() => {
    const all: Project[] = projectsQuery.data?.results ?? [];
    const starred: Project[] = [];
    const ongoing: Project[] = [];
    const archived: Project[] = [];
    for (const p of all) {
      if (p.archived) archived.push(p);
      else if (p.is_starred) starred.push(p);
      else ongoing.push(p);
    }
    return { starred, ongoing, archived };
  }, [projectsQuery.data]);

  const visibleViews = allViews;
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingView, setEditingView] = useState<SavedView | null>(null);
  const [createViewOpen, setCreateViewOpen] = useState(false);

  function handleAllProjectsClick() {
    setProjectId(null);
    if (!pathname.startsWith("/board")) {
      router.push("/board");
    }
    onClose?.();
  }

  function handleProjectClick(id: number) {
    setProjectId(id);
    if (!pathname.startsWith("/board")) {
      router.push("/board");
    }
    onClose?.();
  }

  function handleViewClick(v: SavedView) {
    if (v.project) setProjectId(v.project);
    setViewId(v.id);
    if (!pathname.startsWith("/board")) {
      router.push("/board");
    }
    onClose?.();
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

      {/* Scrollable section list */}
      <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1 py-2 space-y-3">
        {starred.length > 0 && (
          <SidebarSection title="Starred" collapsed={isCollapsed}>
            {starred.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                active={p.id === projectId}
                collapsed={isCollapsed}
                onClick={() => handleProjectClick(p.id)}
              />
            ))}
          </SidebarSection>
        )}

        <SidebarSection
          title="Projects"
          collapsed={isCollapsed}
          action={
            !isCollapsed ? (
              <button
                type="button"
                onClick={() => setCreateProjectOpen(true)}
                className="size-5 grid place-items-center rounded hover:bg-sidebar-accent/60 transition-colors text-muted-foreground hover:text-sidebar-foreground"
                aria-label="New project"
              >
                <Plus className="size-3.5" />
              </button>
            ) : undefined
          }
        >
          {/* All projects row */}
          {isCollapsed ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={handleAllProjectsClick}
                    className={cn(
                      "w-full grid place-items-center py-1.5 rounded-md transition-colors",
                      projectId === null
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
                    )}
                  >
                    <Layers className="size-4" />
                  </button>
                }
              />
              <TooltipContent side="right">All projects</TooltipContent>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={handleAllProjectsClick}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors",
                projectId === null
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
              )}
            >
              <Layers className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">All projects</span>
            </button>
          )}
          {ongoing.length === 0 && !projectsQuery.isLoading && !isCollapsed && (
            <p className="px-2 text-[11px] text-muted-foreground">
              No projects yet.
            </p>
          )}
          {ongoing.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              active={p.id === projectId}
              collapsed={isCollapsed}
              onClick={() => handleProjectClick(p.id)}
            />
          ))}
          {archived.length > 0 && !isCollapsed && (
            <>
              <button
                type="button"
                className="w-full mt-1 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-sidebar-accent/60 transition-colors"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                Show archived ({archived.length})
              </button>
              {showArchived &&
                archived.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    active={p.id === projectId}
                    collapsed={isCollapsed}
                    onClick={() => handleProjectClick(p.id)}
                    muted
                  />
                ))}
            </>
          )}
        </SidebarSection>

        <SidebarSection
          title="Views"
          collapsed={isCollapsed}
          action={
            !isCollapsed ? (
              <button
                type="button"
                onClick={() => setCreateViewOpen(true)}
                className="size-5 grid place-items-center rounded hover:bg-sidebar-accent/60 transition-colors text-muted-foreground hover:text-sidebar-foreground"
                aria-label="New view"
              >
                <Plus className="size-3.5" />
              </button>
            ) : undefined
          }
        >
          {/* Default view row */}
          {isCollapsed ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => { setViewId(null); onClose?.(); }}
                    className={cn(
                      "w-full grid place-items-center py-1.5 rounded-md transition-colors",
                      viewId === null
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
                    )}
                  >
                    <Layers className="size-4" />
                  </button>
                }
              />
              <TooltipContent side="right">All tasks</TooltipContent>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={() => { setViewId(null); onClose?.(); }}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors",
                viewId === null
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
              )}
            >
              <Layers className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">All tasks</span>
            </button>
          )}
            {visibleViews.map((v) =>
              isCollapsed ? (
                <Tooltip key={v.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => handleViewClick(v)}
                        className={cn(
                          "w-full grid place-items-center py-1.5 rounded-md transition-colors",
                          v.id === viewId
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
                        )}
                      >
                        {v.kind === "table" ? (
                          <List className="size-4" />
                        ) : (
                          <LayoutGrid className="size-4" />
                        )}
                      </button>
                    }
                  />
                  <TooltipContent side="right">{v.name}</TooltipContent>
                </Tooltip>
              ) : (
                <div
                  key={v.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleViewClick(v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleViewClick(v);
                    }
                  }}
                  className={cn(
                    "group w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors",
                    v.id === viewId
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
                  )}
                >
                  {v.kind === "table" ? (
                    <List className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate flex-1">{v.name}</span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingView(v);
                      }}
                      className="size-5 grid place-items-center rounded hover:bg-background/60 transition-colors"
                      aria-label={`Edit ${v.name}`}
                    >
                      <Pencil className="size-3 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete view "${v.name}"?`))
                          deleteView.mutate(v.id);
                      }}
                      className="size-5 grid place-items-center rounded hover:bg-destructive/10 transition-colors"
                      aria-label={`Delete ${v.name}`}
                    >
                      <Trash2 className="size-3 text-destructive" />
                    </button>
                  </div>
                </div>
              ),
            )}
          </SidebarSection>
      </nav>

      {/* Footer: user + theme */}
      <div className="shrink-0 border-t border-sidebar-border p-1.5">
        <UserFooter user={user} collapsed={isCollapsed} />
      </div>

      {createProjectOpen && (
        <CreateProjectDialog onClose={() => setCreateProjectOpen(false)} />
      )}
      {editingView && (
        <NewViewDialog
          currentProjectId={projectId}
          existingView={editingView}
          onSaved={(id) => {
            setEditingView(null);
            setViewId(id);
          }}
          onClose={() => setEditingView(null)}
        />
      )}
      {createViewOpen && (
        <NewViewDialog
          currentProjectId={projectId}
          onSaved={(id) => {
            setCreateViewOpen(false);
            setViewId(id);
          }}
          onClose={() => setCreateViewOpen(false)}
        />
      )}
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

function SidebarSection({
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
  if (collapsed) {
    return <div className="space-y-0.5">{children}</div>;
  }
  return (
    <div className="space-y-0.5">
      <div className="px-2 mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

function ProjectRow({
  project,
  active,
  collapsed,
  onClick,
  muted,
}: {
  project: Project;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  muted?: boolean;
}) {
  const router = useRouter();
  const starProject = useStarProject();
  const unstarProject = useUnstarProject();
  const deleteProject = useDeleteProject();

  function toggleStar() {
    if (project.is_starred) unstarProject.mutate(project.id);
    else starProject.mutate(project.id);
  }

  function openSettings() {
    router.push(`/projects/${project.id}`);
  }

  function confirmDelete() {
    if (
      confirm(
        `Delete project "${project.name}" (${project.prefix})?\n\nAll tasks, columns, and recurring templates will be permanently deleted.`,
      )
    ) {
      deleteProject.mutate(project.id);
    }
  }

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onClick}
              className={cn(
                "w-full grid place-items-center py-1.5 rounded-md transition-colors",
                active
                  ? "bg-sidebar-accent"
                  : "hover:bg-sidebar-accent/60",
                muted && "opacity-60",
              )}
            >
              <span
                className="size-3 rounded-full"
                style={{ background: project.color }}
                aria-hidden
              />
            </button>
          }
        />
        <TooltipContent side="right">
          {project.icon ? `${project.icon} ` : ""}
          {project.name}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
        muted && "opacity-60",
      )}
    >
      <span
        className="size-2.5 rounded-full shrink-0"
        style={{ background: project.color }}
        aria-hidden
      />
      {project.icon ? (
        <span className="text-[12px] leading-none w-4 text-center">
          {project.icon}
        </span>
      ) : null}
      <span className="truncate flex-1">{project.name}</span>
      {project.is_starred && !active && (
        <Star className="size-3 fill-current text-muted-foreground shrink-0" />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="size-5 grid place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-background/60 transition-opacity shrink-0"
              aria-label={`Project ${project.name} menu`}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onClick={toggleStar}>
            <Star
              className={cn(
                "size-3.5",
                project.is_starred && "fill-current",
              )}
            />
            {project.is_starred ? "Unstar" : "Star"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openSettings}>
            <Settings className="size-3.5" />
            Project settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={confirmDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
      return apiFetch<User>("/api/auth/me/", {
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
