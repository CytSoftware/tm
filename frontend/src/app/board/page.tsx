"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Check, ChevronDown, Plus, Tag, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ViewSwitcher } from "@/components/views/ViewSwitcher";
import { KanbanColumn } from "@/components/kanban/Column";
import { KanbanCard } from "@/components/kanban/Card";
import { TaskPanel } from "@/components/task/TaskPanel";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { LabelManager } from "@/components/label/LabelManager";
import { ListView } from "@/components/list/ListView";
import { CommandPalette } from "@/components/CommandPalette";
import {
  FilterBar,
  applyBoardFilters,
  boardFiltersFromSavedView,
  savedViewPayloadFromFilters,
} from "@/components/board/FilterBar";
import { apiFetch } from "@/lib/api";
import { projectsKey, viewsKey } from "@/lib/query-keys";
import { useActiveProject } from "@/lib/active-project";
import { useTasksQuery, useMoveTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { connectProjectSocket } from "@/lib/ws";
import type {
  BoardFilters,
  Column,
  Label,
  Project,
  ProjectListResponse,
  Task,
  SavedView,
  SavedViewSort,
  ViewListResponse,
  CardField,
} from "@/lib/types";
import { EMPTY_BOARD_FILTERS } from "@/lib/types";

/** Standard column names and their canonical order. */
const STANDARD_COLUMNS = [
  { name: "Backlog", order: 0, is_done: false },
  { name: "Todo", order: 1, is_done: false },
  { name: "In Progress", order: 2, is_done: false },
  { name: "In Review", order: 3, is_done: false },
  { name: "Done", order: 4, is_done: true },
] as const;

const STANDARD_COL_ORDER: Record<string, number> = Object.fromEntries(
  STANDARD_COLUMNS.map((c) => [c.name, c.order]),
);

export default function BoardPage() {
  const { projectId, setProjectId, viewId, setViewId } = useActiveProject();
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: projectsKey(),
    queryFn: () => apiFetch<ProjectListResponse>("/api/projects/"),
  });
  const projects: Project[] = projectsQuery.data?.results ?? [];
  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  );

  // Fetch active view to determine kind + card_display
  const viewsQuery = useQuery({
    queryKey: viewsKey(),
    queryFn: () => apiFetch<ViewListResponse>("/api/views/"),
  });
  const activeView: SavedView | undefined = useMemo(
    () => (viewsQuery.data?.results ?? []).find((v) => v.id === viewId),
    [viewsQuery.data, viewId],
  );
  const viewKind = activeView?.kind ?? "board";
  const cardDisplay: CardField[] | null = activeView?.card_display ?? null;

  const tasksQuery = useTasksQuery({ projectId, viewId });
  const moveTask = useMoveTask(projectId ?? 0);

  const usersQuery = useUsersQuery();
  const allUsers = usersQuery.data ?? [];

  // Temporary (non-persistent) filter + sort state for the board.
  // Loading a saved view seeds it via the render-time "storing previous
  // render info" pattern, but mutating the state after that does not touch
  // the underlying View — the user has to explicitly "Save to view" to
  // push changes back.
  const [boardFilters, setBoardFilters] = useState<BoardFilters>(
    () => ({ ...EMPTY_BOARD_FILTERS }),
  );
  const [seededForViewId, setSeededForViewId] = useState<
    number | null | "unset"
  >("unset");

  // Fetch all labels for the command palette + filter bar
  const labelsQuery = useQuery({
    queryKey: ["labels"],
    queryFn: () =>
      apiFetch<{ count: number; results: Label[] }>("/api/labels/").then(
        (r) => r.results,
      ),
  });
  const allLabels: Label[] = labelsQuery.data ?? [];

  // Seed the board filter state from the loaded saved view whenever the
  // selected viewId changes. Uses React's "storing information from previous
  // renders" pattern: compare state, update both slices in render, React
  // restarts the render with the fresh state.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (seededForViewId !== viewId) {
    setSeededForViewId(viewId);
    setBoardFilters(
      activeView
        ? boardFiltersFromSavedView(activeView, allLabels, allUsers)
        : { ...EMPTY_BOARD_FILTERS },
    );
  }

  // "Save to view" — flush current temp filters back into the loaded view.
  const saveViewMutation = useMutation({
    mutationFn: async () => {
      if (!activeView) return;
      await apiFetch(`/api/views/${activeView.id}/`, {
        method: "PATCH",
        body: {
          filters: savedViewPayloadFromFilters(boardFilters),
          sort: boardFilters.sort,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: viewsKey() });
    },
  });

  const [dialogState, setDialogState] = useState<
    | { mode: "create"; columnId: number | null }
    | { mode: "edit"; task: Task }
    | null
  >(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // orderedItems: Map<columnId, taskId[]> — local ordering state for DnD
  const [orderedItems, setOrderedItems] = useState<Map<number, number[]>>(
    new Map(),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  useEffect(() => {
    if (!projectId) return;
    return connectProjectSocket({ projectId, queryClient });
  }, [projectId, queryClient]);

  // Raw tasks from the API, then filtered/sorted in memory via the board
  // filter state. This keeps temporary filters instant — no refetch.
  const allTasks = tasksQuery.data?.results ?? [];
  const filteredTasks = useMemo(
    () => applyBoardFilters(allTasks, boardFilters),
    [allTasks, boardFilters],
  );

  // Build column list + task grouping. Projectless tasks land in an Inbox
  // bucket (in the "all projects" view only; the single-project view hides
  // them because they don't belong to any column in the project).
  const { displayColumns, tasksByColumn } = useMemo(() => {
    const tasks = filteredTasks;

    if (project) {
      // Single project — group by column id, skip projectless/columnless tasks.
      const map = new Map<number, Task[]>();
      for (const t of tasks) {
        if (!t.column || t.project !== project.id) continue;
        const arr = map.get(t.column.id) ?? [];
        arr.push(t);
        map.set(t.column.id, arr);
      }
      for (const arr of map.values())
        arr.sort((a, b) => a.position - b.position);
      return {
        displayColumns: project.columns
          .slice()
          .sort((a, b) => a.order - b.order),
        tasksByColumn: map,
      };
    }

    // All projects — group by column name, always include standard columns.
    const byName = new Map<string, Task[]>();

    // Seed all standard column names so empty ones appear
    for (const std of STANDARD_COLUMNS) {
      byName.set(std.name, []);
    }

    // A synthetic "Inbox" bucket for projectless / columnless tasks.
    const INBOX = "Inbox";
    const inboxTasks: Task[] = [];

    for (const t of tasks) {
      if (!t.column) {
        inboxTasks.push(t);
        continue;
      }
      const name = t.column.name;
      const arr = byName.get(name) ?? [];
      arr.push(t);
      byName.set(name, arr);
    }
    for (const arr of byName.values())
      arr.sort((a, b) => a.position - b.position);
    inboxTasks.sort((a, b) => a.position - b.position);

    // Sort columns by standard order, unknowns at the end
    const names = [...byName.keys()].sort(
      (a, b) =>
        (STANDARD_COL_ORDER[a] ?? 99) - (STANDARD_COL_ORDER[b] ?? 99),
    );

    // Use negative synthetic IDs so they don't clash with real column IDs.
    // Inbox always gets id -100 so it's visually distinct from the project
    // virtual columns (-1..-N).
    const virtualCols: Column[] = names.map((name, i) => ({
      id: -(i + 1),
      project: 0,
      name,
      order: STANDARD_COL_ORDER[name] ?? 50 + i,
      is_done: name === "Done",
    }));
    if (inboxTasks.length > 0) {
      virtualCols.unshift({
        id: -100,
        project: 0,
        name: INBOX,
        order: -1,
        is_done: false,
      });
    }

    // Re-key the task map from name to the virtual column's synthetic ID.
    const map = new Map<number, Task[]>();
    for (const vc of virtualCols) {
      if (vc.name === INBOX) {
        map.set(vc.id, inboxTasks);
      } else {
        map.set(vc.id, byName.get(vc.name) ?? []);
      }
    }

    return { displayColumns: virtualCols, tasksByColumn: map };
  }, [filteredTasks, project]);

  // Sync orderedItems from tasksByColumn whenever query data changes
  useEffect(() => {
    const newMap = new Map<number, number[]>();
    for (const [colId, tasks] of tasksByColumn) {
      newMap.set(
        colId,
        tasks.map((t) => t.id),
      );
    }
    setOrderedItems(newMap);
  }, [tasksByColumn]);

  const isAllProjects = !projectId;

  // The currently selected task object (for the command palette)
  const selectedTask = useMemo(() => {
    if (selectedTaskId === null) return null;
    return (
      (tasksQuery.data?.results ?? []).find((t) => t.id === selectedTaskId) ??
      null
    );
  }, [selectedTaskId, tasksQuery.data]);

  // Keyboard navigation — arrow keys, Enter, Esc, Space
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip when an input/textarea/contenteditable is focused
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      // Skip when palette or any dialog is open
      if (paletteOpen || dialogState || createProjectOpen || labelManagerOpen) {
        return;
      }

      // Only handle in board view
      if (viewKind !== "board") return;

      // Build column→task arrays from current display order
      const colTaskIds: number[][] = displayColumns.map(
        (col) => orderedItems.get(col.id) ?? [],
      );

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (selectedTaskId === null) {
            // Select first task of first non-empty column
            for (const ids of colTaskIds) {
              if (ids.length > 0) {
                setSelectedTaskId(ids[0]);
                return;
              }
            }
            return;
          }
          // Move down within current column
          for (const ids of colTaskIds) {
            const idx = ids.indexOf(selectedTaskId);
            if (idx !== -1 && idx < ids.length - 1) {
              setSelectedTaskId(ids[idx + 1]);
              return;
            }
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (selectedTaskId === null) return;
          for (const ids of colTaskIds) {
            const idx = ids.indexOf(selectedTaskId);
            if (idx !== -1 && idx > 0) {
              setSelectedTaskId(ids[idx - 1]);
              return;
            }
          }
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (selectedTaskId === null) {
            // Select first task of first non-empty column
            for (const ids of colTaskIds) {
              if (ids.length > 0) {
                setSelectedTaskId(ids[0]);
                return;
              }
            }
            return;
          }
          // Move to next column
          for (let ci = 0; ci < colTaskIds.length; ci++) {
            const idx = colTaskIds[ci].indexOf(selectedTaskId);
            if (idx !== -1) {
              // Find next column with tasks
              for (let ni = ci + 1; ni < colTaskIds.length; ni++) {
                if (colTaskIds[ni].length > 0) {
                  const targetIdx = Math.min(idx, colTaskIds[ni].length - 1);
                  setSelectedTaskId(colTaskIds[ni][targetIdx]);
                  return;
                }
              }
              return;
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (selectedTaskId === null) return;
          for (let ci = 0; ci < colTaskIds.length; ci++) {
            const idx = colTaskIds[ci].indexOf(selectedTaskId);
            if (idx !== -1) {
              // Find previous column with tasks
              for (let ni = ci - 1; ni >= 0; ni--) {
                if (colTaskIds[ni].length > 0) {
                  const targetIdx = Math.min(idx, colTaskIds[ni].length - 1);
                  setSelectedTaskId(colTaskIds[ni][targetIdx]);
                  return;
                }
              }
              return;
            }
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (selectedTask) {
            setDialogState({ mode: "edit", task: selectedTask });
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          setSelectedTaskId(null);
          break;
        }
        case " ": {
          e.preventDefault();
          setPaletteOpen(true);
          break;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    selectedTaskId,
    selectedTask,
    displayColumns,
    orderedItems,
    paletteOpen,
    dialogState,
    createProjectOpen,
    labelManagerOpen,
    viewKind,
  ]);

  const activeTask = useMemo(() => {
    if (activeId === null) return null;
    return tasksQuery.data?.results.find((t) => t.id === activeId) ?? null;
  }, [activeId, tasksQuery.data]);

  // Helper: find which column in orderedItems contains a given task ID
  const findColumnOfTask = useCallback(
    (taskId: number): number | null => {
      for (const [colId, ids] of orderedItems) {
        if (ids.includes(taskId)) return colId;
      }
      return null;
    },
    [orderedItems],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(Number(event.active.id));
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeTaskId = Number(active.id);
    const overId = String(over.id);

    // Determine the target column and target index
    let targetColId: number | null = null;
    let overIndex: number | null = null;

    // Check if over is a column droppable
    const colMatch = overId.match(/^col-(-?\d+)$/);
    if (colMatch) {
      targetColId = Number(colMatch[1]);
    } else {
      // over is a task
      const overTaskId = Number(overId);
      targetColId = findColumnOfTask(overTaskId);
      if (targetColId != null) {
        const ids = orderedItems.get(targetColId);
        overIndex = ids?.indexOf(overTaskId) ?? null;
      }
    }

    if (targetColId == null) return;

    const sourceColId = findColumnOfTask(activeTaskId);
    if (sourceColId == null) return;

    // If already in the same column, don't do anything here (dnd-kit handles intra-column reorder)
    if (sourceColId === targetColId) return;

    // Move active from source to target
    setOrderedItems((prev) => {
      const next = new Map(prev);
      const sourceIds = [...(next.get(sourceColId) ?? [])];
      const targetIds = [...(next.get(targetColId!) ?? [])];

      // Remove from source
      const srcIdx = sourceIds.indexOf(activeTaskId);
      if (srcIdx === -1) return prev;
      sourceIds.splice(srcIdx, 1);

      // Insert at target position
      if (overIndex != null && overIndex >= 0) {
        targetIds.splice(overIndex, 0, activeTaskId);
      } else {
        targetIds.push(activeTaskId);
      }

      next.set(sourceColId, sourceIds);
      next.set(targetColId!, targetIds);
      return next;
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeTaskId = Number(active.id);
    const movingTask = tasksQuery.data?.results.find(
      (t) => t.id === activeTaskId,
    );
    if (!movingTask) return;

    // Projectless (Inbox) tasks can't be moved via drag — the API requires
    // a column id and Inbox has none. Ignore the drop.
    if (movingTask.project == null) return;

    // Find which column the task ended up in (from orderedItems)
    const finalColId = findColumnOfTask(activeTaskId);
    if (finalColId == null) return;

    // Get position info
    const finalIds = orderedItems.get(finalColId) ?? [];
    const finalIndex = finalIds.indexOf(activeTaskId);

    // Determine actual target column ID for the API call
    let targetColumnId: number | null = null;
    if (finalColId > 0) {
      targetColumnId = finalColId;
    } else {
      // Virtual column — find the real column for the task's project
      const vc = displayColumns.find((c) => c.id === finalColId);
      if (vc) {
        const realProject = projects.find(
          (p) => p.id === movingTask.project,
        );
        const realCol = realProject?.columns.find(
          (c) => c.name === vc.name,
        );
        targetColumnId = realCol?.id ?? null;
      }
    }

    if (!targetColumnId) return;

    // Check if nothing actually changed
    const sameColumn = movingTask.column?.id === targetColumnId;
    if (sameColumn && finalIds.length <= 1) return;

    // Compute before_id / after_id from the finalIds order
    let before_id: number | undefined;
    let after_id: number | undefined;

    // The task directly above in the final order
    if (finalIndex > 0) {
      after_id = finalIds[finalIndex - 1];
    }
    // The task directly below
    if (finalIndex < finalIds.length - 1) {
      before_id = finalIds[finalIndex + 1];
    }

    // Skip if same column and same position
    if (sameColumn && !before_id && !after_id) return;

    moveTask.mutate({
      key: movingTask.key,
      column_id: targetColumnId,
      before_id: before_id ?? null,
      after_id: after_id ?? null,
    });
  }

  const availableColumnNames = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTasks) {
      if (t.column?.name) set.add(t.column.name);
    }
    return Array.from(set).sort(
      (a, b) =>
        (STANDARD_COL_ORDER[a] ?? 99) - (STANDARD_COL_ORDER[b] ?? 99),
    );
  }, [allTasks]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <BoardHeader
        projects={projects}
        project={project}
        projectId={projectId}
        onProjectChange={(id) => setProjectId(id)}
        onNewProject={() => setCreateProjectOpen(true)}
        viewId={viewId}
        onViewChange={setViewId}
        onNewTask={() =>
          setDialogState({ mode: "create", columnId: null })
        }
        onManageLabels={() => setLabelManagerOpen(true)}
        boardFilters={boardFilters}
        onBoardFiltersChange={setBoardFilters}
        users={allUsers}
        labels={allLabels}
        availableColumnNames={availableColumnNames}
        activeView={activeView ?? null}
        onSaveToView={
          activeView ? () => saveViewMutation.mutate() : undefined
        }
      />
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden bg-muted/40">
        {projects.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <span>No projects yet.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreateProjectOpen(true)}
            >
              <Plus className="size-3.5" />
              Create your first project
            </Button>
          </div>
        ) : viewKind === "table" ? (
          <ListView
            tasks={filteredTasks}
            showProject={isAllProjects}
            sort={boardFilters.sort}
            onSortChange={(sort) =>
              setBoardFilters({ ...boardFilters, sort })
            }
            onTaskClick={(task) => setDialogState({ mode: "edit", task })}
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-3 h-full px-4 py-3">
              {displayColumns.map((col) => {
                const tasks = tasksByColumn.get(col.id) ?? [];
                const itemIds = orderedItems.get(col.id) ?? tasks.map((t) => t.id);
                return (
                  <KanbanColumn
                    key={col.id}
                    column={col}
                    tasks={tasks}
                    onAddTask={
                      project
                        ? () =>
                            setDialogState({
                              mode: "create",
                              columnId: col.id,
                            })
                        : undefined
                    }
                  >
                    <SortableContext
                      items={itemIds}
                      strategy={verticalListSortingStrategy}
                    >
                      {itemIds.map((taskId) => {
                        const task = filteredTasks.find(
                          (t) => t.id === taskId,
                        );
                        if (!task) return null;
                        return (
                          <KanbanCard
                            key={task.id}
                            task={task}
                            isSelected={task.id === selectedTaskId}
                            showProject={isAllProjects}
                            visibleFields={cardDisplay}
                            onClick={() =>
                              setDialogState({ mode: "edit", task })
                            }
                          />
                        );
                      })}
                    </SortableContext>
                  </KanbanColumn>
                );
              })}
            </div>
            <DragOverlay>
              {activeTask ? (
                <KanbanCard
                  task={activeTask}
                  showProject={isAllProjects}
                  visibleFields={cardDisplay}
                  isOverlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
      {dialogState && (
        <TaskPanel
          projects={projects}
          activeProject={project ?? projects[0] ?? null}
          mode={dialogState.mode}
          initialColumnId={
            dialogState.mode === "create"
              ? dialogState.columnId ?? undefined
              : undefined
          }
          task={
            dialogState.mode === "edit" ? dialogState.task : undefined
          }
          onClose={() => setDialogState(null)}
        />
      )}
      {createProjectOpen && (
        <CreateProjectDialog onClose={() => setCreateProjectOpen(false)} />
      )}
      {labelManagerOpen && (
        <LabelManager
          projectId={project?.id ?? null}
          projectName={project?.name ?? null}
          onClose={() => setLabelManagerOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          selectedTask={selectedTask}
          project={project}
          projects={projects}
          users={allUsers}
          labels={allLabels}
          views={viewsQuery.data?.results ?? []}
          onClose={() => setPaletteOpen(false)}
          onEditTask={(task) => setDialogState({ mode: "edit", task })}
          onCreateTask={() =>
            setDialogState({ mode: "create", columnId: null })
          }
          onCreateProject={() => setCreateProjectOpen(true)}
          onCreateLabel={() => setLabelManagerOpen(true)}
          onSwitchProject={(id) => setProjectId(id)}
          onSwitchView={(id) => setViewId(id)}
        />
      )}
    </div>
  );
}

function BoardHeader({
  projects,
  project,
  projectId,
  onProjectChange,
  onNewProject,
  viewId,
  onViewChange,
  onNewTask,
  onManageLabels,
  boardFilters,
  onBoardFiltersChange,
  users,
  labels,
  availableColumnNames,
  activeView,
  onSaveToView,
}: {
  projects: Project[];
  project: Project | undefined;
  projectId: number | null;
  onProjectChange: (id: number | null) => void;
  onNewProject: () => void;
  viewId: number | null;
  onViewChange: (id: number | null) => void;
  onNewTask: () => void;
  onManageLabels: () => void;
  boardFilters: BoardFilters;
  onBoardFiltersChange: (next: BoardFilters) => void;
  users: import("@/lib/types").User[];
  labels: Label[];
  availableColumnNames: string[];
  activeView: SavedView | null;
  onSaveToView?: () => void;
}) {
  const qc = useQueryClient();
  const deleteProject = useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/projects/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectsKey() });
    },
  });

  function handleDeleteProject(p: Project) {
    if (
      !confirm(
        `Delete project "${p.name}" (${p.prefix})?\n\nAll tasks, columns, labels, and recurring templates will be permanently deleted.`,
      )
    )
      return;
    deleteProject.mutate(p.id);
  }

  return (
    <header className="shrink-0 h-12 flex items-center gap-1.5 px-4 border-b border-border/80 bg-background">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-40 justify-between text-[13px] shrink-0"
            >
              {project ? (
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ background: project.color }}
                  />
                  <span className="truncate">{project.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {project.prefix}
                  </span>
                </span>
              ) : (
                "All projects"
              )}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Projects
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onProjectChange(null)}>
              {!projectId ? (
                <Check className="size-3.5 shrink-0" />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              All projects
            </DropdownMenuItem>
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                className="flex items-center justify-between group/item"
                onClick={() => onProjectChange(p.id)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {p.id === projectId ? (
                    <Check className="size-3.5 shrink-0" />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ background: p.color }}
                    aria-hidden
                  />
                  <span className="truncate">{p.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                    {p.prefix}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteProject(p);
                  }}
                  className="size-6 grid place-items-center rounded opacity-0 group-hover/item:opacity-100 hover:bg-destructive/10 transition-opacity"
                  aria-label={`Delete ${p.name}`}
                >
                  <Trash2 className="size-3 text-destructive" />
                </button>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNewProject}>
            <Plus className="size-3.5" />
            New project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-5 w-px bg-border mx-0.5 shrink-0" />
      <ViewSwitcher
        projectId={projectId}
        viewId={viewId}
        onViewChange={onViewChange}
      />
      <div className="h-5 w-px bg-border mx-0.5 shrink-0" />

      {/* Filter + sort + search inlined into the header row */}
      <FilterBar
        filters={boardFilters}
        onFiltersChange={onBoardFiltersChange}
        projects={projects}
        users={users}
        labels={labels}
        availableColumns={availableColumnNames}
        loadedView={activeView}
        onSaveToView={onSaveToView}
      />

      <div className="h-5 w-px bg-border mx-0.5 shrink-0" />
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-[13px] shrink-0"
        onClick={onManageLabels}
      >
        <Tag className="size-3.5" />
        Labels
      </Button>
      <Button
        size="sm"
        className="h-8 text-[13px] shrink-0"
        onClick={onNewTask}
      >
        <Plus className="size-3.5" />
        New task
      </Button>
    </header>
  );
}
