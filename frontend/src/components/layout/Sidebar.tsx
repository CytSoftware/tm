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

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import {
  Activity,
  Archive,
  ArchiveRestore,
  BarChart3,
  BookText,
  ChevronRight,
  ChevronsLeft,
  GitPullRequest,
  HardDrive,
  Home,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Plus,
  Settings,
  Sparkles,
  Star,
  Target,
  Trash2,
  Webhook,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/UserAvatar";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { ModeToggle } from "./ModeToggle";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { meKey } from "@/lib/query-keys";
import { logout as apiLogout } from "@/lib/auth";
import { useSidebar } from "@/lib/sidebar-state";
import { useActiveProject } from "@/lib/active-project";
import {
  useProjectsQuery,
  useStarProject,
  useUnstarProject,
  useDeleteProject,
  useUpdateProject,
  useReorderProjects,
} from "@/hooks/use-projects";
import { useToReviewQuery } from "@/hooks/use-tasks";
import type { Me, Project, User } from "@/lib/types";

type ProjectSection = "favorites" | "projects";

type ProjectDragData = {
  type: "sidebar-project";
  projectId: number;
  section: ProjectSection;
};

function isProjectDrag(
  d: Record<string, unknown>,
): d is ProjectDragData & Record<string, unknown> {
  return d.type === "sidebar-project";
}

/** Sort by the user's manual sidebar order (nulls last), then name. */
function sortForSidebar(list: Project[]): Project[] {
  return [...list].sort((a, b) => {
    const ap = a.sidebar_position;
    const bp = b.sidebar_position;
    if (ap != null && bp != null && ap !== bp) return ap - bp;
    if (ap != null && bp == null) return -1;
    if (ap == null && bp != null) return 1;
    return a.name.localeCompare(b.name);
  });
}

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
  const { projectId, setProjectId } = useActiveProject();

  const isCollapsed = mobile ? false : collapsed;

  const projectsQuery = useProjectsQuery();
  const reorderProjects = useReorderProjects();
  const toReviewCount = useToReviewQuery().data?.length ?? 0;
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const allProjects = useMemo(
    () => projectsQuery.data?.results ?? [],
    [projectsQuery.data],
  );
  const favorites = useMemo(
    () => sortForSidebar(allProjects.filter((p) => p.is_starred && !p.archived)),
    [allProjects],
  );
  const projects = useMemo(
    () => sortForSidebar(allProjects.filter((p) => !p.is_starred && !p.archived)),
    [allProjects],
  );
  const archived = useMemo(
    () =>
      [...allProjects.filter((p) => p.archived)].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [allProjects],
  );

  function openProject(id: number) {
    setProjectId(id);
    router.push("/board");
    onClose?.();
  }

  // Single drop monitor: reorder within a section, then persist the full
  // per-user order (favorites-in-order ++ projects-in-order). Re-subscribes
  // when the ordered lists change so it always reads current arrangement.
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isProjectDrag(source.data),
      onDrop: ({ source, location }) => {
        if (!isProjectDrag(source.data)) return;
        const target = location.current.dropTargets[0];
        if (!target || !isProjectDrag(target.data)) return;
        const { section } = source.data;
        if (target.data.section !== section) return;
        if (target.data.projectId === source.data.projectId) return;

        const sectionList = section === "favorites" ? favorites : projects;
        const ids = sectionList.map((p) => p.id);
        const fromIdx = ids.indexOf(source.data.projectId);
        const overIdx = ids.indexOf(target.data.projectId);
        if (fromIdx === -1 || overIdx === -1) return;

        const edge = extractClosestEdge(target.data);
        const without = ids.filter((id) => id !== source.data.projectId);
        const overInWithout = without.indexOf(target.data.projectId);
        const insertIdx = overInWithout + (edge === "bottom" ? 1 : 0);
        without.splice(insertIdx, 0, source.data.projectId);

        const favIds = favorites.map((p) => p.id);
        const projIds = projects.map((p) => p.id);
        const fullOrder =
          section === "favorites"
            ? [...without, ...projIds]
            : [...favIds, ...without];
        reorderProjects.mutate(fullOrder);
      },
    });
  }, [favorites, projects, reorderProjects]);

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
            <Activity
              className={
                isCollapsed
                  ? "size-4"
                  : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
          }
          label="Events"
          active={pathname.startsWith("/events")}
          collapsed={isCollapsed}
          onNavigate={() => {
            router.push("/events");
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

        {/* ── Projects ────────────────────────────────────────────── */}
        {favorites.length > 0 && (
          <ProjectGroup
            title="Favorites"
            collapsed={isCollapsed}
            count={favorites.length}
          >
            {favorites.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                section="favorites"
                active={p.id === projectId && pathname.startsWith("/board")}
                collapsed={isCollapsed}
                draggable={!isCollapsed && favorites.length > 1}
                onClick={() => openProject(p.id)}
              />
            ))}
          </ProjectGroup>
        )}

        <ProjectGroup
          title="Projects"
          collapsed={isCollapsed}
          action={
            !isCollapsed && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setCreateProjectOpen(true)}
                      className="size-5 grid place-items-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
                      aria-label="New project"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  }
                />
                <TooltipContent>New project</TooltipContent>
              </Tooltip>
            )
          }
        >
          {projects.length === 0 && !isCollapsed ? (
            <p className="px-2 py-1.5 text-[12px] text-muted-foreground/70">
              No projects yet.
            </p>
          ) : (
            projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                section="projects"
                active={p.id === projectId && pathname.startsWith("/board")}
                collapsed={isCollapsed}
                draggable={!isCollapsed && projects.length > 1}
                onClick={() => openProject(p.id)}
              />
            ))
          )}
        </ProjectGroup>

        {!isCollapsed && archived.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              className="w-full flex items-center gap-1 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform",
                  archivedOpen && "rotate-90",
                )}
              />
              <span>Archived</span>
              <span className="tabular-nums">{archived.length}</span>
            </button>
            {archivedOpen &&
              archived.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  section="projects"
                  active={p.id === projectId && pathname.startsWith("/board")}
                  collapsed={false}
                  draggable={false}
                  muted
                  onClick={() => openProject(p.id)}
                />
              ))}
          </div>
        )}

        {/* Analytics is intentionally separated from the everyday workspace
            links. It stays easy to find without competing with Tasks, Bets,
            or the project list for primary-navigation attention. */}
        <ProjectGroup title="Insights" collapsed={isCollapsed}>
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
        </ProjectGroup>
      </nav>

      {/* Footer: user + theme */}
      <div className="shrink-0 border-t border-sidebar-border p-1.5">
        <UserFooter user={user} collapsed={isCollapsed} />
      </div>

      {createProjectOpen && (
        <CreateProjectDialog onClose={() => setCreateProjectOpen(false)} />
      )}
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Project sections
// ────────────────────────────────────────────────────────────────────────

function ProjectGroup({
  title,
  collapsed,
  count,
  action,
  children,
}: {
  title: string;
  collapsed: boolean;
  count?: number;
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
          {count != null && count > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground/50">
              {count}
            </span>
          )}
          <span className="ml-auto">{action}</span>
        </div>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ProjectRow({
  project,
  section,
  active,
  collapsed,
  draggable: isDraggable,
  muted,
  onClick,
}: {
  project: Project;
  section: ProjectSection;
  active: boolean;
  collapsed: boolean;
  draggable: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  const router = useRouter();
  const starProject = useStarProject();
  const unstarProject = useUnstarProject();
  const deleteProject = useDeleteProject();
  const updateProject = useUpdateProject(project.id);

  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<"top" | "bottom" | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isDraggable) return;
    const data: ProjectDragData = {
      type: "sidebar-project",
      projectId: project.id,
      section,
    };
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ ...data }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          isProjectDrag(source.data) &&
          source.data.section === section &&
          source.data.projectId !== project.id,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { ...data },
            { input, element, allowedEdges: ["top", "bottom"] },
          ),
        onDrag: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          setClosestEdge(edge === "top" || edge === "bottom" ? edge : null);
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
        getIsSticky: () => true,
      }),
    );
  }, [project.id, section, isDraggable]);

  function toggleStar() {
    if (project.is_starred) unstarProject.mutate(project.id);
    else starProject.mutate(project.id);
  }

  function toggleArchive() {
    updateProject.mutate({ archived: !project.archived });
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
                active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
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
      ref={ref}
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
        "group relative flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
        muted && "opacity-60",
        isDragging && "opacity-40",
      )}
    >
      {closestEdge && (
        <span
          className={cn(
            "absolute left-1 right-1 h-0.5 rounded-full bg-primary",
            closestEdge === "top" ? "-top-px" : "-bottom-px",
          )}
          aria-hidden
        />
      )}
      <span
        className="size-2.5 rounded-full shrink-0"
        style={{ background: project.color }}
        aria-hidden
      />
      {project.icon ? (
        <span className="text-[12px] leading-none w-4 text-center shrink-0">
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
        <DropdownMenuContent
          align="start"
          className="w-48"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onClick={toggleStar}>
            <Star className={cn("size-3.5", project.is_starred && "fill-current")} />
            {project.is_starred ? "Unstar" : "Star"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(`/projects/${project.id}`)}>
            <Settings className="size-3.5" />
            Project settings
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleArchive}>
            {project.archived ? (
              <>
                <ArchiveRestore className="size-3.5" />
                Unarchive
              </>
            ) : (
              <>
                <Archive className="size-3.5" />
                Archive
              </>
            )}
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => router.push("/settings/webhooks")}
              aria-label="Webhook settings"
            >
              <Webhook className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>Webhooks</TooltipContent>
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
