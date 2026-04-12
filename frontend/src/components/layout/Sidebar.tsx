"use client";

/**
 * Left-rail sidebar — the permanent primary navigation surface for the app.
 *
 * Sections (v1):
 *   1. Starred projects (only rendered when the user has stars)
 *   2. Projects — non-archived, non-starred (with a "show archived" toggle)
 *   3. Views — saved views (flat list, filtered to the active project + globals)
 *
 * Clicking a project calls `setProjectId(p.id)` then navigates to /board so
 * the sidebar works from any route (including /projects/[id]).
 *
 * Flex layout: the sidebar itself is the top-level flex container; only the
 * middle region (project lists) scrolls, so the Cyt header and the user
 * footer stay pinned. Carries `min-h-0` on the scroll region to respect the
 * no-page-scroll invariant from app/layout.tsx.
 */

import { useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  List,
  LogOut,
  MoreHorizontal,
  Plus,
  Settings,
  Star,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ModeToggle } from "./ModeToggle";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { meKey, viewsKey } from "@/lib/query-keys";
import { logout as apiLogout } from "@/lib/auth";
import { useActiveProject } from "@/lib/active-project";
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

export function Sidebar({ user }: { user: User }) {
  const router = useRouter();
  const pathname = usePathname();
  const { projectId, viewId, setProjectId, setViewId } = useActiveProject();

  const projectsQuery = useProjectsQuery();

  const viewsQuery = useQuery({
    queryKey: viewsKey(),
    queryFn: () => apiFetch<ViewListResponse>("/api/views/"),
  });
  const allViews: SavedView[] = viewsQuery.data?.results ?? [];

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

  // Views visible in the sidebar: globals + those scoped to any project the
  // user can see. We don't filter by active project here on purpose — the
  // sidebar is a nav surface, not a scoped view.
  const visibleViews = allViews;

  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  function handleProjectClick(id: number) {
    setProjectId(id);
    if (!pathname.startsWith("/board")) {
      router.push("/board");
    }
  }

  function handleViewClick(v: SavedView) {
    if (v.project) setProjectId(v.project);
    setViewId(v.id);
    if (!pathname.startsWith("/board")) {
      router.push("/board");
    }
  }

  return (
    <aside className="w-60 shrink-0 h-screen flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="shrink-0 h-12 flex items-center justify-between px-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-md bg-foreground grid place-items-center text-background text-[11px] font-semibold">
            C
          </div>
          <span className="text-[13px] font-semibold tracking-tight">Cyt</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="New project"
          onClick={() => setCreateProjectOpen(true)}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {/* Scrollable section list */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-4">
        {starred.length > 0 && (
          <SidebarSection title="Starred">
            {starred.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                active={p.id === projectId}
                onClick={() => handleProjectClick(p.id)}
              />
            ))}
          </SidebarSection>
        )}

        <SidebarSection title="Projects">
          {ongoing.length === 0 && !projectsQuery.isLoading && (
            <p className="px-2 text-[11px] text-muted-foreground">
              No projects yet.
            </p>
          )}
          {ongoing.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              active={p.id === projectId}
              onClick={() => handleProjectClick(p.id)}
            />
          ))}
          {archived.length > 0 && (
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
                    onClick={() => handleProjectClick(p.id)}
                    muted
                  />
                ))}
            </>
          )}
        </SidebarSection>

        {visibleViews.length > 0 && (
          <SidebarSection title="Views">
            {visibleViews.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => handleViewClick(v)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors",
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
                <span className="truncate">{v.name}</span>
              </button>
            ))}
          </SidebarSection>
        )}
      </nav>

      {/* Footer: user + theme */}
      <div className="shrink-0 border-t border-sidebar-border p-2">
        <UserFooter user={user} />
      </div>

      {createProjectOpen && (
        <CreateProjectDialog onClose={() => setCreateProjectOpen(false)} />
      )}
    </aside>
  );
}

function SidebarSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="px-2 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
        {title}
      </div>
      {children}
    </div>
  );
}

function ProjectRow({
  project,
  active,
  onClick,
  muted,
}: {
  project: Project;
  active: boolean;
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

function UserFooter({ user }: { user: User }) {
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
        <PopoverContent align="start" side="top" className="w-72 p-3 space-y-3">
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
