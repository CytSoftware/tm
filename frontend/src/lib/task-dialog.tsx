"use client";

/**
 * Global task dialog controller.
 *
 * Owns a single TaskPanel mounted above the shell so any page — sidebar,
 * backlog, settings, global search — can open or create a task with one
 * function call. Replaces the per-page dialog state that used to live in
 * board/page.tsx.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { TaskPanel } from "@/components/task/TaskPanel";
import { apiFetch } from "@/lib/api";
import { useActiveProject } from "@/lib/active-project";
import { useProjectsQuery } from "@/hooks/use-projects";
import { recordRecentTask } from "@/lib/recent-tasks";
import type { Task } from "@/lib/types";

type DialogState =
  | { mode: "create"; columnId: number | null; projectId: number | null }
  | { mode: "edit"; task: Task }
  | null;

type TaskDialogContextValue = {
  openTask: (task: Task) => void;
  openTaskByKey: (key: string) => Promise<void>;
  createTask: (opts?: {
    projectId?: number | null;
    columnId?: number | null;
  }) => void;
  close: () => void;
  isOpen: boolean;
};

const Ctx = createContext<TaskDialogContextValue | null>(null);

export function TaskDialogProvider({ children }: { children: ReactNode }) {
  const { projectId: activeProjectId } = useActiveProject();
  const projectsQuery = useProjectsQuery();
  const projects = useMemo(
    () => (projectsQuery.data?.results ?? []).filter((p) => !p.archived),
    [projectsQuery.data],
  );

  const [state, setState] = useState<DialogState>(null);

  /**
   * Back-button close (TAS-061).
   *
   * The panel is an overlay, not a route, so without this the Android back
   * gesture / browser Back navigates away from the board entirely rather than
   * dismissing the panel — the single most jarring thing about the panel on a
   * phone. We push one history entry per open panel and pop it on close.
   *
   * The pushed entry keeps the current URL and spreads the existing
   * `history.state` so the App Router's own bookkeeping survives the round
   * trip; only our marker is added.
   */
  const pushedRef = useRef(false);

  useEffect(() => {
    if (!state || pushedRef.current) return;
    pushedRef.current = true;
    window.history.pushState(
      { ...window.history.state, cytTaskPanel: true },
      "",
      window.location.href,
    );
  }, [state]);

  useEffect(() => {
    function onPopState() {
      // Only react to the pop of *our* entry. If we popped it ourselves from
      // `close`, pushedRef is already false and this is a no-op.
      if (!pushedRef.current) return;
      pushedRef.current = false;
      setState(null);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openTask = useCallback((task: Task) => {
    recordRecentTask(task);
    setState({ mode: "edit", task });
  }, []);

  const openTaskByKey = useCallback(async (key: string) => {
    try {
      const task = await apiFetch<Task>(
        `/api/tasks/${encodeURIComponent(key)}/`,
      );
      recordRecentTask(task);
      setState({ mode: "edit", task });
    } catch {
      // Task not found or request failed — swallow so the caller UI doesn't
      // crash; the command palette will just close without effect.
    }
  }, []);

  const createTask = useCallback(
    (opts?: { projectId?: number | null; columnId?: number | null }) => {
      setState({
        mode: "create",
        columnId: opts?.columnId ?? null,
        projectId: opts?.projectId ?? activeProjectId,
      });
    },
    [activeProjectId],
  );

  const close = useCallback(() => {
    setState(null);
    if (pushedRef.current) {
      pushedRef.current = false;
      // Unwind the entry we pushed so Back doesn't need two presses to leave
      // the page after the panel has been dismissed some other way.
      window.history.back();
    }
  }, []);

  const value = useMemo<TaskDialogContextValue>(
    () => ({
      openTask,
      openTaskByKey,
      createTask,
      close,
      isOpen: state !== null,
    }),
    [openTask, openTaskByKey, createTask, close, state],
  );

  // Pick the "active" project context for TaskPanel.
  const activeProjectForPanel = useMemo(() => {
    if (!state) return null;
    if (state.mode === "edit") {
      return projects.find((p) => p.id === state.task.project) ?? null;
    }
    return projects.find((p) => p.id === state.projectId) ?? null;
  }, [state, projects]);

  // Force a fresh TaskPanel per task so its internal form state resets
  // cleanly when the dialog is reopened on a different task without an
  // unmount/remount between them.
  const panelKey =
    state?.mode === "edit"
      ? `edit-${state.task.id}`
      : state?.mode === "create"
        ? `create-${state.projectId ?? "x"}-${state.columnId ?? "x"}`
        : null;

  return (
    <Ctx.Provider value={value}>
      {children}
      {state?.mode === "edit" && (
        <TaskPanel
          key={panelKey ?? undefined}
          projects={projects}
          activeProject={activeProjectForPanel ?? projects[0] ?? null}
          mode="edit"
          task={state.task}
          onClose={close}
        />
      )}
      {state?.mode === "create" && (
        <TaskPanel
          key={panelKey ?? undefined}
          projects={projects}
          activeProject={activeProjectForPanel ?? projects[0] ?? null}
          mode="create"
          initialColumnId={state.columnId ?? undefined}
          onClose={close}
        />
      )}
    </Ctx.Provider>
  );
}

export function useTaskDialog(): TaskDialogContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useTaskDialog must be used inside <TaskDialogProvider>",
    );
  }
  return ctx;
}
