"use client";

/**
 * /projects — the workspace-wide project index.
 *
 * The board's project picker only ever shows *active* projects, so before
 * this page an archived project was unreachable from the UI: nothing linked
 * to `/projects/[id]` once it left the picker. This page is the one surface
 * that lists everything, and the only way back from archived.
 *
 * Deliberately not here: drag-reordering (the sidebar owns `sidebar_position`)
 * and the edit form (that's `/projects/[id]`). Cards carry only what you need
 * to *choose* a project — colour, key prefix, description, open-task count —
 * plus the two reversible actions, star and archive.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderKanban,
  Plus,
  Settings,
  Star,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import {
  useProjectsQuery,
  useStarProject,
  useUnstarProject,
  useUpdateProject,
} from "@/hooks/use-projects";
import { useActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";

/**
 * Starred first, then the user's manual `sidebar_position` (nulls last, i.e.
 * never-reordered projects sink below ones that were), then name. This is the
 * ordering the per-user `is_starred` / `sidebar_position` fields were added
 * for, so any other project list that grows an order should use the same one.
 */
function compareProjects(a: Project, b: Project): number {
  if (a.is_starred !== b.is_starred) return a.is_starred ? -1 : 1;
  const ap = a.sidebar_position ?? Number.MAX_SAFE_INTEGER;
  const bp = b.sidebar_position ?? Number.MAX_SAFE_INTEGER;
  if (ap !== bp) return ap - bp;
  return a.name.localeCompare(b.name);
}

export default function ProjectsPage() {
  const projectsQuery = useProjectsQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const { active, archived } = useMemo(() => {
    const all = [...(projectsQuery.data?.results ?? [])].sort(compareProjects);
    return {
      active: all.filter((p) => !p.archived),
      archived: all.filter((p) => p.archived),
    };
  }, [projectsQuery.data]);

  const isLoading = projectsQuery.isLoading;

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 max-lg:px-3 py-1.5 border-b border-border/80 bg-background">
        <FolderKanban className="size-4 text-indigo-500" />
        <h1 className="text-[13px] font-semibold tracking-tight">Projects</h1>
        <span className="hidden md:inline text-[11px] text-muted-foreground">
          Every project in the workspace — open one, star it, or dig out
          something archived.
        </span>
        <div className="ml-auto">
          <Button
            size="sm"
            className="h-7 text-[12px] tap-target"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            New project
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto max-w-5xl px-4 py-5 space-y-6">
          {isLoading ? (
            <div className="grid place-items-center py-16">
              <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
            </div>
          ) : projectsQuery.isError ? (
            <div className="rounded-lg border border-border/60 bg-card py-14 px-6 text-center text-[12.5px] text-muted-foreground">
              Couldn&apos;t load projects. Retrying shortly.
            </div>
          ) : (
            <>
              <section>
                <h2 className="mb-2 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Active
                  <span className="tabular-nums">{active.length}</span>
                </h2>
                {active.length === 0 ? (
                  <div className="rounded-lg border border-border/60 bg-card py-12 px-6 text-center">
                    <p className="text-[12.5px] font-medium">
                      No active projects.
                    </p>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      {archived.length > 0
                        ? "Everything is archived — unarchive one below, or start fresh."
                        : "Create one to start tracking work."}
                    </p>
                    <Button
                      size="sm"
                      className="mt-3 h-7 text-[12px] tap-target"
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      New project
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                    {active.map((p) => (
                      <ProjectCard key={p.id} project={p} />
                    ))}
                  </div>
                )}
              </section>

              <ArchivedSection
                projects={archived}
                open={archivedOpen}
                onToggle={() => setArchivedOpen((v) => !v)}
              />
            </>
          )}
        </div>
      </div>

      {createOpen && (
        <CreateProjectDialog onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Active project card
// ────────────────────────────────────────────────────────────────────────

function ProjectCard({ project }: { project: Project }) {
  const router = useRouter();
  const { projectId: activeProjectId, setProjectId } = useActiveProject();
  const star = useStarProject();
  const unstar = useUnstarProject();
  const updateProject = useUpdateProject(project.id);

  /** Opening a project is "make it the active one, then show the board" —
   *  selection lives in the active-project context, never the URL (TAS-065). */
  function open() {
    setProjectId(project.id);
    router.push("/board");
  }

  function toggleStar() {
    (project.is_starred ? unstar : star).mutate(project.id);
  }

  // Archive is fully reversible, so it skips the confirm dialog that the
  // destructive delete on /projects/[id] still uses — the toast carries the
  // undo instead.
  //
  // Two details worth keeping: archiving the *active* project has to clear the
  // selection, or the board keeps querying an id its own picker no longer
  // lists and renders those tasks under an "All projects" heading. And the
  // undo runs after this card has unmounted (the project moved to the archived
  // list), where TanStack drops per-`mutate` callbacks — `hasListeners()` is
  // false with no mounted observer — so it reports errors off `mutateAsync`
  // instead. The hook's own `onSuccess` invalidation still fires either way.
  function archive() {
    const wasActive = activeProjectId === project.id;
    updateProject.mutate(
      { archived: true },
      {
        onSuccess: () => {
          if (wasActive) setProjectId(null);
          toast.success(`Archived ${project.name}`, {
            action: {
              label: "Undo",
              onClick: () => {
                updateProject
                  .mutateAsync({ archived: false })
                  .then(() => {
                    if (wasActive) setProjectId(project.id);
                  })
                  .catch(() =>
                    toast.error(`Couldn't restore ${project.name}.`),
                  );
              },
            },
          });
        },
        onError: () => toast.error(`Couldn't archive ${project.name}.`),
      },
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        // Only when the card itself has focus: keydown bubbles, so without
        // this an Enter/Space on the star or archive button would fire the
        // button *and* navigate to the board.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] cursor-pointer transition-colors hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ background: project.color }}
          aria-hidden
        />
        {project.icon && (
          <span className="text-[13px] leading-none shrink-0">
            {project.icon}
          </span>
        )}
        <span className="text-[13px] font-medium truncate">{project.name}</span>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">
          {project.prefix}
        </span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {/* The star reflects state, so it stays painted; the two navigation
              /state actions are hover-revealed on pointer devices and always
              visible on touch, where there is no hover to reveal them. */}
          <IconAction
            label={project.is_starred ? "Unstar project" : "Star project"}
            onClick={toggleStar}
          >
            <Star
              className={cn(
                "size-3.5",
                project.is_starred
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground",
              )}
            />
          </IconAction>
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover-none:opacity-100">
            <IconAction
              label="Project settings"
              onClick={() => router.push(`/projects/${project.id}`)}
            >
              <Settings className="size-3.5 text-muted-foreground" />
            </IconAction>
            <IconAction
              label="Archive project"
              disabled={updateProject.isPending}
              onClick={archive}
            >
              <Archive className="size-3.5 text-muted-foreground" />
            </IconAction>
          </div>
        </div>
      </div>

      <p
        className={cn(
          "text-[11.5px] leading-relaxed line-clamp-2",
          project.description
            ? "text-muted-foreground"
            : "text-muted-foreground/60 italic",
        )}
      >
        {project.description || "No description"}
      </p>

      <div className="mt-auto pt-1 text-[11px] text-muted-foreground">
        <span className="tabular-nums font-medium text-foreground">
          {project.open_task_count}
        </span>{" "}
        open {project.open_task_count === 1 ? "task" : "tasks"}
      </div>
    </div>
  );
}

/** Small square action button. Painted at `size-6` to keep the card dense,
 *  with `tap-target` growing only the hit area to 44px on touch. */
function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="tap-target size-6 grid place-items-center rounded-md transition-colors hover:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Archived
// ────────────────────────────────────────────────────────────────────────

/** Secondary, collapsed by default — archived projects are an escape hatch,
 *  not part of the everyday list. Rendered even when empty so the "where did
 *  my archived projects go" question has a visible answer. */
function ArchivedSection({
  projects,
  open,
  onToggle,
}: {
  projects: Project[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="tap-target mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight
          className={cn(
            "size-3 transition-transform",
            open && "rotate-90",
          )}
        />
        Archived
        <span className="tabular-nums">{projects.length}</span>
      </button>
      {open && (
        <div className="rounded-lg border border-border/40 bg-card/50">
          {projects.length === 0 ? (
            <p className="py-8 px-6 text-center text-[12px] text-muted-foreground">
              Nothing archived.
            </p>
          ) : (
            <ul className="px-3 py-2">
              {projects.map((p) => (
                <ArchivedRow key={p.id} project={p} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function ArchivedRow({ project }: { project: Project }) {
  const router = useRouter();
  const updateProject = useUpdateProject(project.id);

  function unarchive() {
    updateProject.mutate(
      { archived: false },
      {
        onSuccess: () => toast.success(`Restored ${project.name}`),
        onError: () => toast.error(`Couldn't unarchive ${project.name}.`),
      },
    );
  }

  return (
    <li className="flex items-center gap-2 rounded-md px-1.5 py-1.5">
      <span
        className="size-2 rounded-full shrink-0 opacity-60"
        style={{ background: project.color }}
        aria-hidden
      />
      <span className="text-[12.5px] text-muted-foreground truncate">
        {project.name}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground/70 shrink-0">
        {project.prefix}
      </span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] tap-target"
          onClick={() => router.push(`/projects/${project.id}`)}
        >
          <Settings className="size-3" />
          <span className="max-lg:sr-only">Settings</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px] tap-target"
          disabled={updateProject.isPending}
          onClick={unarchive}
        >
          <ArchiveRestore className="size-3" />
          Unarchive
        </Button>
      </div>
    </li>
  );
}
