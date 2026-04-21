"use client";

import {
  Fragment,
  ReactNode,
  useCallback,
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
import { Plus, Repeat, Settings, Tag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { KanbanColumn } from "@/components/kanban/Column";
import { KanbanCard } from "@/components/kanban/Card";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { LabelManager } from "@/components/label/LabelManager";
import { RecurringManager } from "@/components/recurring/RecurringManager";
import { ListView } from "@/components/list/ListView";
import { CommandPalette } from "@/components/CommandPalette";
import { DeclutterDialog } from "@/components/declutter/DeclutterDialog";
import { AssignDialog } from "@/components/declutter/AssignDialog";
import {
  FilterBar,
  boardFiltersFromSavedView,
  savedViewPayloadFromFilters,
} from "@/components/board/FilterBar";
import { apiFetch } from "@/lib/api";
import { viewsKey } from "@/lib/query-keys";
import { useActiveProject } from "@/lib/active-project";
import { useTaskDialog } from "@/lib/task-dialog";
import { useProjectsQuery } from "@/hooks/use-projects";
import {
  flattenInfinite,
  useMoveTask,
  useTasksInfinite,
} from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { connectProjectSocket } from "@/lib/ws";
import type {
  BoardFilters,
  Column,
  Label,
  Project,
  Task,
  SavedView,
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
  onAssign?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
};

function DroppableColumn({
  columnId,
  column,
  tasks,
  children,
  onAddTask,
  onDeclutter,
  onAssign,
  hasMore,
  isLoadingMore,
  onLoadMore,
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
      onAssign={onAssign}
      bodyRef={bodyRef}
      isDraggingOver={isDraggingOver}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      onLoadMore={onLoadMore}
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

  const moveTask = useMoveTask();

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

  const taskDialog = useTaskDialog();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);
  const [recurringManagerOpen, setRecurringManagerOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [declutterOpen, setDeclutterOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

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

  // Which columns should we render? Single project → real columns by order.
  // All-projects → fixed set of virtual columns (negative ids so they don't
  // collide with real column ids when the drag monitor maps back to a real
  // column via `STANDARD_COL_ORDER`).
  const displayColumns: Column[] = useMemo(() => {
    if (project) {
      return project.columns.slice().sort((a, b) => a.order - b.order);
    }
    return STANDARD_COLUMNS.map((std, i) => ({
      id: -(i + 1),
      project: 0,
      name: std.name,
      order: std.order,
      is_done: std.is_done,
    }));
  }, [project]);

  // Per-column results are fetched inside <ColumnContainer>s below and lifted
  // back here via callback. The map is what the drag monitor + keyboard nav
  // + selected-task lookup read from.
  const [tasksByColumn, setTasksByColumn] = useState<Map<number, Task[]>>(
    () => new Map(),
  );
  const onColumnTasksChange = useCallback(
    (columnId: number, tasks: Task[]) => {
      setTasksByColumn((prev) => {
        const existing = prev.get(columnId);
        if (
          existing &&
          existing.length === tasks.length &&
          existing.every((t, i) => t === tasks[i])
        ) {
          return prev;
        }
        const next = new Map(prev);
        next.set(columnId, tasks);
        return next;
      });
    },
    [],
  );

  const isAllProjects = !projectId;

  // The currently selected task — pulled from whichever column's loaded
  // page happens to carry it.
  const selectedTask = useMemo(() => {
    if (selectedTaskId === null) return null;
    for (const tasks of tasksByColumn.values()) {
      const hit = tasks.find((t) => t.id === selectedTaskId);
      if (hit) return hit;
    }
    return null;
  }, [selectedTaskId, tasksByColumn]);

  // Resolve the currently-dragged task up here so any column can render it
  // as a ghost in its preview slot — the destination column's own query
  // doesn't contain the source card during a cross-column drag.
  const draggedTask = useMemo(() => {
    if (!dragPreview) return null;
    for (const tasks of tasksByColumn.values()) {
      const hit = tasks.find((t) => t.id === dragPreview.sourceTaskId);
      if (hit) return hit;
    }
    return null;
  }, [dragPreview, tasksByColumn]);

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
        taskDialog.isOpen ||
        createProjectOpen ||
        labelManagerOpen ||
        recurringManagerOpen ||
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
            taskDialog.openTask(selectedTask);
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
    taskDialog,
    createProjectOpen,
    labelManagerOpen,
    recurringManagerOpen,
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
        let movingTask: Task | undefined;
        for (const tasks of tasksByColumn.values()) {
          const hit = tasks.find((t) => t.id === sourceTaskId);
          if (hit) {
            movingTask = hit;
            break;
          }
        }
        if (!movingTask || movingTask.project == null) return;

        const destTasks = (tasksByColumn.get(destColId) ?? []).filter(
          (t) => t.id !== sourceTaskId,
        );
        // after = the task that should sit above the moved card; before =
        // the task that should sit below. The backend resolves these ids
        // globally (not scoped to the target column) so virtual all-projects
        // drops compute positions from whichever cards were visually on
        // either side of the drop slot.
        const afterId =
          insertIdx > 0 ? destTasks[insertIdx - 1]?.id : undefined;
        const beforeId =
          insertIdx < destTasks.length ? destTasks[insertIdx]?.id : undefined;

        // Virtual col → real col for the API call. We also grab the real
        // Column object so the mutation's optimistic insert can attach the
        // correct ``column`` to the card before the server confirms it.
        let targetColumnId: number | null = null;
        let targetColumn: Column | undefined;
        if (destColId > 0) {
          targetColumnId = destColId;
          targetColumn = displayColumns.find((c) => c.id === destColId);
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
            targetColumn = realCol;
          }
        }
        if (!targetColumnId) return;

        // Approximate the position the server will assign, so the
        // optimistic insert slots the card into the exact spot the user
        // dropped it — otherwise the card disappears for the full network
        // round-trip. Mirrors the backend ``_compute_position`` arithmetic
        // using whatever positions we can see locally.
        const afterTask = afterId
          ? destTasks.find((t) => t.id === afterId)
          : undefined;
        const beforeTask = beforeId
          ? destTasks.find((t) => t.id === beforeId)
          : undefined;
        let estimatedPosition: number;
        if (afterTask && beforeTask) {
          estimatedPosition = (afterTask.position + beforeTask.position) / 2;
        } else if (afterTask) {
          estimatedPosition = afterTask.position + 1000;
        } else if (beforeTask) {
          estimatedPosition = beforeTask.position - 1000;
        } else {
          const tail = destTasks.reduce(
            (m, t) => (t.position > m ? t.position : m),
            0,
          );
          estimatedPosition = tail + 1000;
        }

        // The server persists the new position regardless of the current
        // sort. We used to auto-flip sort to ``position`` here so the drag
        // result was immediately visible, but that changes the queryKey and
        // forces every column's paginated cache to refetch from offset 0 —
        // the user loses their scroll position on every drag. Leave sort
        // alone; if the user is sorted by something other than position the
        // drag still persists, it just isn't visible until they switch to
        // manual order.
        moveTask.mutate({
          key: movingTask.key,
          column_id: targetColumnId,
          before_id: beforeId ?? null,
          after_id: afterId ?? null,
          optimistic: targetColumn
            ? { destColumn: targetColumn, estimatedPosition }
            : undefined,
        });
      },
    });
  }, [
    tasksByColumn,
    displayColumns,
    projects,
    boardFilters,
    moveTask,
  ]);

  // Column names available as a filter option. With server-side pagination we
  // only see the pages that are loaded, so we derive this from the project's
  // real columns (or the canonical standard columns in all-projects mode) —
  // that way the option stays correct even before any page has loaded.
  const availableColumnNames = useMemo(() => {
    if (project) {
      return project.columns
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((c) => c.name);
    }
    return STANDARD_COLUMNS.map((c) => c.name);
  }, [project]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <BoardHeader
        projects={projects}
        project={project}
        projectId={projectId}
        onNewTask={() => taskDialog.createTask({ columnId: null })}
        onManageLabels={() => setLabelManagerOpen(true)}
        onManageRecurring={() => setRecurringManagerOpen(true)}
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
          <TableContainer
            projectId={projectId}
            filters={boardFilters}
            showProject={isAllProjects}
            onSortChange={(sort) =>
              setBoardFilters({ ...boardFilters, sort })
            }
            onTaskClick={(task) => taskDialog.openTask(task)}
          />
        ) : (
          <div className="flex gap-3 h-full px-4 py-3">
            {displayColumns.map((col) => (
              <ColumnContainer
                key={col.id}
                column={col}
                projectId={projectId}
                filters={boardFilters}
                dragPreview={dragPreview}
                draggedTask={draggedTask}
                isAllProjects={isAllProjects}
                cardDisplay={cardDisplay}
                selectedTaskId={selectedTaskId}
                onTasksChange={onColumnTasksChange}
                onAddTask={
                  project
                    ? () => taskDialog.createTask({ columnId: col.id })
                    : undefined
                }
                onEditTask={(task) => taskDialog.openTask(task)}
                onDeclutter={() => setDeclutterOpen(true)}
                onAssign={() => setAssignOpen(true)}
              />
            ))}
          </div>
        )}
      </div>
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
      {recurringManagerOpen && (
        <RecurringManager
          projectId={project?.id ?? null}
          projects={projects}
          onClose={() => setRecurringManagerOpen(false)}
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
          onEditTask={(task) => taskDialog.openTask(task)}
          onCreateTask={() => taskDialog.createTask({ columnId: null })}
          onCreateProject={() => setCreateProjectOpen(true)}
          onCreateLabel={() => setLabelManagerOpen(true)}
          onSwitchProject={(id) => setProjectId(id)}
          onSwitchView={(id) => setViewId(id)}
        />
      )}
      <DeclutterDialog
        open={declutterOpen}
        onOpenChange={setDeclutterOpen}
        projects={projects}
        scopeProjectId={projectId}
      />
      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        projects={projects}
        users={allUsers}
        scopeProjectId={projectId}
      />
    </div>
  );
}

type ColumnContainerProps = {
  column: Column;
  projectId: number | null;
  filters: BoardFilters;
  dragPreview: {
    sourceTaskId: number;
    destColumnId: number;
    insertIndex: number;
  } | null;
  /** The task currently being dragged, resolved at the parent level so the
   *  destination column can render the ghost even when the source card
   *  lives in a different column's query cache. */
  draggedTask: Task | null;
  isAllProjects: boolean;
  cardDisplay: CardField[] | null;
  selectedTaskId: number | null;
  onTasksChange: (columnId: number, tasks: Task[]) => void;
  onAddTask?: () => void;
  onEditTask: (task: Task) => void;
  onDeclutter: () => void;
  onAssign: () => void;
};

/** Owns a single column's infinite task query and renders its cards.
 *  Lifted out so each column gets its own ``useInfiniteQuery`` hook — one
 *  call per render is all TanStack needs, but the hook count per render of
 *  the parent board page must stay stable, so it can't live in a map. */
function ColumnContainer({
  column,
  projectId,
  filters,
  dragPreview,
  draggedTask,
  isAllProjects,
  cardDisplay,
  selectedTaskId,
  onTasksChange,
  onAddTask,
  onEditTask,
  onDeclutter,
  onAssign,
}: ColumnContainerProps) {
  // Real columns have positive ids + a concrete `project` fk. All-projects
  // virtual columns have negative ids and only a column name.
  const isVirtual = column.id < 0;
  const query = useTasksInfinite({
    projectId,
    columnId: isVirtual ? null : column.id,
    columnName: isVirtual ? column.name : null,
    filters,
    limit: 50,
  });

  const tasks = useMemo(() => flattenInfinite(query.data), [query.data]);

  useEffect(() => {
    onTasksChange(column.id, tasks);
  }, [column.id, tasks, onTasksChange]);

  const fetchNextPage = query.fetchNextPage;
  const handleLoadMore = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  const visibleTasks = dragPreview
    ? tasks.filter((t) => t.id !== dragPreview.sourceTaskId)
    : tasks;
  const isDest = dragPreview?.destColumnId === column.id;
  const previewIdx = isDest ? dragPreview!.insertIndex : -1;

  const ghost = draggedTask ? (
    <div
      key="__preview"
      className="pointer-events-none opacity-50 rounded-lg border-2 border-dashed border-primary/40"
    >
      <KanbanCard
        task={draggedTask}
        showProject={isAllProjects}
        visibleFields={cardDisplay}
      />
    </div>
  ) : null;

  return (
    <DroppableColumn
      columnId={column.id}
      column={column}
      tasks={tasks}
      hasMore={query.hasNextPage ?? false}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={handleLoadMore}
      onAddTask={onAddTask}
      onDeclutter={onDeclutter}
      onAssign={onAssign}
    >
      {visibleTasks.map((task, idx) => (
        <Fragment key={task.id}>
          {isDest && idx === previewIdx && ghost}
          <DraggableCard task={task} columnId={column.id}>
            {({ isDragging }) => (
              <KanbanCard
                task={task}
                isDragging={isDragging}
                isSelected={task.id === selectedTaskId}
                showProject={isAllProjects}
                visibleFields={cardDisplay}
                onClick={() => onEditTask(task)}
              />
            )}
          </DraggableCard>
        </Fragment>
      ))}
      {isDest && previewIdx === visibleTasks.length && ghost}
    </DroppableColumn>
  );
}

type TableContainerProps = {
  projectId: number | null;
  filters: BoardFilters;
  showProject: boolean;
  onSortChange: (sort: BoardFilters["sort"]) => void;
  onTaskClick: (task: Task) => void;
};

/** Single-query paginated list for the table view. Larger page size than the
 *  per-column kanban queries because a visible list row is cheaper than a
 *  rendered card. */
function TableContainer({
  projectId,
  filters,
  showProject,
  onSortChange,
  onTaskClick,
}: TableContainerProps) {
  const query = useTasksInfinite({
    projectId,
    filters,
    limit: 100,
  });
  const tasks = useMemo(() => flattenInfinite(query.data), [query.data]);
  const fetchNextPage = query.fetchNextPage;
  const handleLoadMore = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  return (
    <ListView
      tasks={tasks}
      showProject={showProject}
      sort={filters.sort}
      onSortChange={onSortChange}
      onTaskClick={onTaskClick}
      hasMore={query.hasNextPage ?? false}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={handleLoadMore}
    />
  );
}

function BoardHeader({
  projects,
  project,
  projectId,
  onNewTask,
  onManageLabels,
  onManageRecurring,
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
  onManageRecurring: () => void;
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
        variant="outline"
        size="sm"
        className="h-8 text-[13px] shrink-0"
        onClick={onManageRecurring}
      >
        <Repeat className="size-3.5" />
        Recurring
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
