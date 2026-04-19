"use client";

import {
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
import { Plus, Settings, Tag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { KanbanColumn } from "@/components/kanban/Column";
import { KanbanCard } from "@/components/kanban/Card";
import { TaskPanel } from "@/components/task/TaskPanel";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { LabelManager } from "@/components/label/LabelManager";
import { ListView } from "@/components/list/ListView";
import { CommandPalette } from "@/components/CommandPalette";
import { DeclutterDialog } from "@/components/declutter/DeclutterDialog";
import {
  FilterBar,
  applyBoardFilters,
  boardFiltersFromSavedView,
  savedViewPayloadFromFilters,
} from "@/components/board/FilterBar";
import { apiFetch } from "@/lib/api";
import { viewsKey } from "@/lib/query-keys";
import { useActiveProject } from "@/lib/active-project";
import { useProjectsQuery } from "@/hooks/use-projects";
import { useTasksQuery, useMoveTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { connectProjectSocket } from "@/lib/ws";
import type {
  BoardFilters,
  Column,
  Label,
  Project,
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

type CardDragData = {
  type: "card";
  taskId: number;
  columnId: number;
};

type ColumnDropData = {
  type: "column";
  columnId: number;
};

function isCardData(
  data: Record<string, unknown>,
): data is CardDragData & Record<string, unknown> {
  return data.type === "card";
}

function isColumnData(
  data: Record<string, unknown>,
): data is ColumnDropData & Record<string, unknown> {
  return data.type === "column";
}

type DraggableCardProps = {
  task: Task;
  columnId: number;
  children: (state: { isDragging: boolean }) => ReactNode;
};

function DraggableCard({ task, columnId, children }: DraggableCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: (): CardDragData => ({
          type: "card",
          taskId: task.id,
          columnId,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          isCardData(source.data) && source.data.taskId !== task.id,
        getData: ({ input, element }) => {
          // `attachClosestEdge` writes the closest edge (top/bottom) onto
          // the target data. The board-level monitor reads it via
          // `extractClosestEdge` to compute where the preview should go.
          const data: CardDragData = {
            type: "card",
            taskId: task.id,
            columnId,
          };
          return attachClosestEdge(data, {
            input,
            element,
            allowedEdges: ["top", "bottom"],
          });
        },
        getIsSticky: () => true,
      }),
    );
  }, [task.id, columnId]);

  return <div ref={ref}>{children({ isDragging })}</div>;
}

type DroppableColumnProps = {
  columnId: number;
  column: Column;
  tasks: Task[];
  children: ReactNode;
  onAddTask?: () => void;
  onDeclutter?: () => void;
};

function DroppableColumn({
  columnId,
  column,
  tasks,
  children,
  onAddTask,
  onDeclutter,
}: DroppableColumnProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isCardData(source.data),
      getData: (): ColumnDropData => ({ type: "column", columnId }),
      onDragEnter: () => setIsDraggingOver(true),
      onDragLeave: () => setIsDraggingOver(false),
      onDrop: () => setIsDraggingOver(false),
    });
  }, [columnId]);

  return (
    <KanbanColumn
      column={column}
      tasks={tasks}
      onAddTask={onAddTask}
      onDeclutter={onDeclutter}
      bodyRef={bodyRef}
      isDraggingOver={isDraggingOver}
    >
      {children}
    </KanbanColumn>
  );
}

export default function BoardPage() {
  const { projectId, setProjectId, viewId, setViewId } = useActiveProject();
  const queryClient = useQueryClient();

  const projectsQuery = useProjectsQuery();
  const projects: Project[] = (projectsQuery.data?.results ?? []).filter(
    (p) => !p.archived,
  );
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
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [declutterOpen, setDeclutterOpen] = useState(false);

  // Anticipated drop position, updated as the user drags. Drives the
  // in-list ghost preview: the source task gets filtered out of its
  // column and a faded copy is injected at the destination's insertIdx.
  const [dragPreview, setDragPreview] = useState<{
    sourceTaskId: number;
    destColumnId: number;
    insertIndex: number;
  } | null>(null);

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

  // Build column list + task grouping. Projectless / columnless tasks are
  // skipped on the board — they have no column to live in. They still appear
  // in the List view and can be edited via the task panel or command palette.
  const { displayColumns, tasksByColumn } = useMemo(() => {
    const tasks = filteredTasks;

    if (project) {
      // Single project — group by column id, skip projectless/columnless tasks.
      // Iteration preserves the order of `filteredTasks`, which is already
      // sorted by the user's chosen sort (via applyBoardSort).
      const map = new Map<number, Task[]>();
      for (const t of tasks) {
        if (!t.column || t.project !== project.id) continue;
        const arr = map.get(t.column.id) ?? [];
        arr.push(t);
        map.set(t.column.id, arr);
      }
      return {
        displayColumns: project.columns
          .slice()
          .sort((a, b) => a.order - b.order),
        tasksByColumn: map,
      };
    }

    // All projects — group by column name, always include standard columns.
    // Tasks without a column are skipped (no visual home on the Kanban).
    const byName = new Map<string, Task[]>();
    for (const std of STANDARD_COLUMNS) {
      byName.set(std.name, []);
    }

    for (const t of tasks) {
      if (!t.column) continue;
      const name = t.column.name;
      const arr = byName.get(name) ?? [];
      arr.push(t);
      byName.set(name, arr);
    }

    // Sort columns by standard order, unknowns at the end. Use negative
    // synthetic IDs so they don't clash with real column IDs.
    const names = [...byName.keys()].sort(
      (a, b) =>
        (STANDARD_COL_ORDER[a] ?? 99) - (STANDARD_COL_ORDER[b] ?? 99),
    );
    const virtualCols: Column[] = names.map((name, i) => ({
      id: -(i + 1),
      project: 0,
      name,
      order: STANDARD_COL_ORDER[name] ?? 50 + i,
      is_done: name === "Done",
    }));

    const map = new Map<number, Task[]>();
    for (const vc of virtualCols) {
      map.set(vc.id, byName.get(vc.name) ?? []);
    }

    return { displayColumns: virtualCols, tasksByColumn: map };
  }, [filteredTasks, project]);

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
      if (
        paletteOpen ||
        dialogState ||
        createProjectOpen ||
        labelManagerOpen ||
        declutterOpen
      ) {
        return;
      }

      // Only handle in board view
      if (viewKind !== "board") return;

      // Build column→task arrays from the current server order.
      const colTaskIds: number[][] = displayColumns.map(
        (col) => (tasksByColumn.get(col.id) ?? []).map((t) => t.id),
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
    tasksByColumn,
    paletteOpen,
    dialogState,
    createProjectOpen,
    labelManagerOpen,
    declutterOpen,
    viewKind,
  ]);

  // pragmatic-dnd has no drop animation — the card just teleports to its
  // destination slot on commit, so there's no animation window for an
  // optimistic cache update to collide with. The monitor is the single
  // place where a drop gets translated into a `moveTask` mutation. It
  // re-registers whenever the inputs it reads change; that's cheap, and
  // keeps the closure values fresh without ref gymnastics.
  useEffect(() => {
    /**
     * Compute `{ destColumnId, insertIndex }` from the current drop target.
     * Used by both the live drag preview (on every `onDrag`) and the final
     * commit (on `onDrop`). Returns null if the target can't be resolved.
     */
    const resolveDropTarget = (
      sourceTaskId: number,
      dropTarget: { data: Record<string, unknown> } | undefined,
    ): { destColumnId: number; insertIndex: number } | null => {
      if (!dropTarget) return null;
      const data = dropTarget.data;
      if (isCardData(data)) {
        const destColId = data.columnId;
        const overTaskId = data.taskId;
        const edge = extractClosestEdge(data);
        const destTasks = (tasksByColumn.get(destColId) ?? []).filter(
          (t) => t.id !== sourceTaskId,
        );
        const overIdx = destTasks.findIndex((t) => t.id === overTaskId);
        if (overIdx === -1) return null;
        return {
          destColumnId: destColId,
          insertIndex: overIdx + (edge === "bottom" ? 1 : 0),
        };
      }
      if (isColumnData(data)) {
        const destColId = data.columnId;
        const destTasks = (tasksByColumn.get(destColId) ?? []).filter(
          (t) => t.id !== sourceTaskId,
        );
        return {
          destColumnId: destColId,
          insertIndex: destTasks.length,
        };
      }
      return null;
    };

    return monitorForElements({
      canMonitor: ({ source }) => isCardData(source.data),
      onDragStart: () => setDragPreview(null),
      onDrag: ({ source, location }) => {
        if (!isCardData(source.data)) return;
        const resolved = resolveDropTarget(
          source.data.taskId,
          location.current.dropTargets[0],
        );
        if (!resolved) {
          setDragPreview((prev) => (prev === null ? prev : null));
          return;
        }
        setDragPreview((prev) => {
          if (
            prev &&
            prev.sourceTaskId === source.data.taskId &&
            prev.destColumnId === resolved.destColumnId &&
            prev.insertIndex === resolved.insertIndex
          ) {
            return prev;
          }
          return {
            sourceTaskId: source.data.taskId as number,
            destColumnId: resolved.destColumnId,
            insertIndex: resolved.insertIndex,
          };
        });
      },
      onDrop: ({ source, location }) => {
        setDragPreview(null);
        if (!isCardData(source.data)) return;
        const resolved = resolveDropTarget(
          source.data.taskId,
          location.current.dropTargets[0],
        );
        if (!resolved) return;

        const { destColumnId: destColId, insertIndex: insertIdx } = resolved;
        const sourceTaskId = source.data.taskId;
        const movingTask = tasksQuery.data?.results.find(
          (t) => t.id === sourceTaskId,
        );
        if (!movingTask || movingTask.project == null) return;

        const destTasks = (tasksByColumn.get(destColId) ?? []).filter(
          (t) => t.id !== sourceTaskId,
        );
        const afterId =
          insertIdx > 0 ? destTasks[insertIdx - 1]?.id : undefined;
        const beforeId =
          insertIdx < destTasks.length ? destTasks[insertIdx]?.id : undefined;

        // Virtual col → real col for the API call.
        let targetColumnId: number | null = null;
        if (destColId > 0) {
          targetColumnId = destColId;
        } else {
          const vc = displayColumns.find((c) => c.id === destColId);
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

        // Flip to manual sort so drag result sticks under any saved view.
        const primarySort = boardFilters.sort[0];
        if (primarySort && primarySort.field !== "position") {
          setBoardFilters({
            ...boardFilters,
            sort: [{ field: "position", dir: "asc" }],
          });
        }

        moveTask.mutate({
          key: movingTask.key,
          column_id: targetColumnId,
          before_id: beforeId ?? null,
          after_id: afterId ?? null,
        });
      },
    });
  }, [
    tasksByColumn,
    displayColumns,
    projects,
    tasksQuery.data,
    boardFilters,
    moveTask,
  ]);

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
          <div className="flex gap-3 h-full px-4 py-3">
            {displayColumns.map((col) => {
              const tasks = tasksByColumn.get(col.id) ?? [];
              const sourceTask = dragPreview
                ? (tasksQuery.data?.results.find(
                    (t) => t.id === dragPreview.sourceTaskId,
                  ) ?? null)
                : null;
              // Remove the source card from the visible list while dragging.
              // Its slot collapses, the surrounding cards reflow, and a
              // ghost copy gets injected at the anticipated drop location
              // below — that's the "preview in new position" effect.
              const visibleTasks = dragPreview
                ? tasks.filter((t) => t.id !== dragPreview.sourceTaskId)
                : tasks;
              const isDest = dragPreview?.destColumnId === col.id;
              const previewIdx = isDest ? dragPreview!.insertIndex : -1;
              const ghost = sourceTask ? (
                <div
                  key="__preview"
                  className="pointer-events-none opacity-50 rounded-lg border-2 border-dashed border-primary/40"
                >
                  <KanbanCard
                    task={sourceTask}
                    showProject={isAllProjects}
                    visibleFields={cardDisplay}
                  />
                </div>
              ) : null;

              return (
                <DroppableColumn
                  key={col.id}
                  columnId={col.id}
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
                  onDeclutter={() => setDeclutterOpen(true)}
                >
                  {visibleTasks.map((task, idx) => (
                    <Fragment key={task.id}>
                      {isDest && idx === previewIdx && ghost}
                      <DraggableCard task={task} columnId={col.id}>
                        {({ isDragging }) => (
                          <KanbanCard
                            task={task}
                            isDragging={isDragging}
                            isSelected={task.id === selectedTaskId}
                            showProject={isAllProjects}
                            visibleFields={cardDisplay}
                            onClick={() =>
                              setDialogState({ mode: "edit", task })
                            }
                          />
                        )}
                      </DraggableCard>
                    </Fragment>
                  ))}
                  {isDest && previewIdx === visibleTasks.length && ghost}
                </DroppableColumn>
              );
            })}
          </div>
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
      <DeclutterDialog
        open={declutterOpen}
        onOpenChange={setDeclutterOpen}
        tasks={tasksQuery.data?.results ?? []}
        projects={projects}
        scopeProjectId={projectId}
      />
    </div>
  );
}

function BoardHeader({
  projects,
  project,
  projectId,
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
  const router = useRouter();

  return (
    <header className="shrink-0 h-12 flex items-center gap-1.5 px-4 border-b border-border/80 bg-background">
      {/* Breadcrumb — the sidebar owns project switching. Click to open settings. */}
      {project ? (
        <button
          type="button"
          onClick={() => router.push(`/projects/${project.id}`)}
          className="flex items-center gap-2 min-w-0 h-8 px-2 -ml-2 rounded-md hover:bg-accent/60 transition-colors group shrink-0"
        >
          <span
            className="size-2 rounded-full shrink-0"
            style={{ background: project.color }}
            aria-hidden
          />
          {project.icon && (
            <span className="text-[13px] leading-none">{project.icon}</span>
          )}
          <span className="text-[13px] font-medium truncate">
            {project.name}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {project.prefix}
          </span>
          <Settings className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      ) : (
        <span className="text-[13px] font-medium text-muted-foreground px-2 -ml-2 shrink-0">
          All projects
        </span>
      )}
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
