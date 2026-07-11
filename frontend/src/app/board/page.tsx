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
import {
  ChevronDown,
  GitBranch,
  Layers,
  Plus,
  Repeat,
  Settings,
  Tag,
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
import { AddColumnCell, CollapsedColumn, KanbanColumn } from "@/components/kanban/Column";
import { DeleteColumnDialog } from "@/components/kanban/DeleteColumnDialog";
import { KanbanCard, type EditorKind } from "@/components/kanban/Card";
import { PropertyPalette } from "@/components/board/PropertyPalette";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { LabelManager } from "@/components/label/LabelManager";
import { RecurringManager } from "@/components/recurring/RecurringManager";
import { ListView } from "@/components/list/ListView";
import { DeclutterDialog } from "@/components/declutter/DeclutterDialog";
import { AssignDialog } from "@/components/declutter/AssignDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ActiveFilterChips,
  FilterBar,
  boardFiltersFromSavedView,
  savedViewPayloadFromFilters,
} from "@/components/board/FilterBar";
import { ViewSwitcher } from "@/components/views/ViewSwitcher";
import { apiFetch } from "@/lib/api";
import { viewsKey } from "@/lib/query-keys";
import { useActiveProject } from "@/lib/active-project";
import {
  usePalette,
  usePalettePageContext,
  type PaletteAction,
} from "@/lib/palette";
import { useTaskDialog } from "@/lib/task-dialog";
import { useProjectsQuery } from "@/hooks/use-projects";
import {
  flattenInfinite,
  useMoveTask,
  useTasksInfinite,
  useUpdateTask,
} from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import {
  useCreateColumn,
  useDeleteColumn,
  useReorderColumns,
  useUpdateColumn,
} from "@/hooks/use-columns";
import { useBoardColumnPrefs } from "@/hooks/use-board-column-prefs";
import { connectProjectSocket } from "@/lib/ws";
import type {
  BoardFilters,
  Column,
  ColumnKind,
  Label,
  Priority,
  Project,
  Task,
  SavedView,
  ViewListResponse,
  CardField,
} from "@/lib/types";
import { EMPTY_BOARD_FILTERS } from "@/lib/types";

/** Standard column names and their canonical order. */
const STANDARD_COLUMNS = [
  { name: "Backlog", order: 0, is_done: false, kind: "backlog" },
  { name: "Todo", order: 1, is_done: false, kind: "todo" },
  { name: "In Progress", order: 2, is_done: false, kind: "in_progress" },
  { name: "In Review", order: 3, is_done: false, kind: "review" },
  { name: "Done", order: 4, is_done: true, kind: "done" },
] as const satisfies readonly {
  name: string;
  order: number;
  is_done: boolean;
  kind: ColumnKind;
}[];

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
  isInitialLoading?: boolean;
  totalCount?: number;
  manageable?: boolean;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  onRename?: (newName: string) => void;
  onSetKind?: (kind: ColumnKind) => void;
  onMove?: (direction: "left" | "right") => void;
  onRequestDelete?: () => void;
  onHide?: () => void;
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
  isInitialLoading,
  totalCount,
  manageable,
  canMoveLeft,
  canMoveRight,
  onRename,
  onSetKind,
  onMove,
  onRequestDelete,
  onHide,
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
      isInitialLoading={isInitialLoading}
      totalCount={totalCount}
      manageable={manageable}
      canMoveLeft={canMoveLeft}
      canMoveRight={canMoveRight}
      onRename={onRename}
      onSetKind={onSetKind}
      onMove={onMove}
      onRequestDelete={onRequestDelete}
      onHide={onHide}
    >
      {children}
    </KanbanColumn>
  );
}

export default function BoardPage() {
  const { projectId, setProjectId, viewId, setViewId } = useActiveProject();
  const queryClient = useQueryClient();

  const projectsQuery = useProjectsQuery();
  const allProjects: Project[] = projectsQuery.data?.results ?? [];
  const projects: Project[] = allProjects.filter((p) => !p.archived);
  const hasArchivedProjects = allProjects.some((p) => p.archived);
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
  const updateTask = useUpdateTask();

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
  //
  // Wait until the views query has actually resolved before seeding: if we
  // seed on first render while ``activeView`` is still undefined (because
  // viewsQuery hasn't returned), ``seededForViewId`` ratchets forward and
  // the view's filters never get applied — every column fires with empty
  // filters and fetches the full unfiltered dataset.
  const viewsLoaded = viewsQuery.data !== undefined;
  const canSeedForView = viewId == null || viewsLoaded;
  if (canSeedForView && seededForViewId !== viewId) {
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
  // Which property PropertyPalette is open for the selected task — forced
  // open by the keyboard (`p`/`a`/`l` — see the keyboard effect below) or
  // opened from a chip click via handleEditorOpenRequest. Rendered once at
  // the page level (see the JSX below), not per-card — see PropertyPalette.
  const [openEditor, setOpenEditor] = useState<EditorKind | null>(null);
  // Chip click on any card → select that card and open the matching palette,
  // so the palette behaves identically whether opened by click or keyboard.
  const handleEditorOpenRequest = useCallback(
    (taskId: number, kind: EditorKind) => {
      setSelectedTaskId(taskId);
      setOpenEditor(kind);
    },
    [],
  );
  const [helpOpen, setHelpOpen] = useState(false);
  // Unified ⌘K palette open state — owned by PaletteContext (the Shell
  // mounts the palette and binds ⌘K); the board only reads it to keep its
  // own keydown handler quiet while the palette is up.
  const { open: paletteOpen } = usePalette();
  const [declutterOpen, setDeclutterOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [columnPendingDelete, setColumnPendingDelete] =
    useState<Column | null>(null);

  const createColumn = useCreateColumn();
  const updateColumn = useUpdateColumn();
  const deleteColumn = useDeleteColumn();
  const reorderColumns = useReorderColumns();
  // Per-user, per-project collapsed/hidden columns. ``projectId`` is null on
  // the all-projects board — the hook maps that to the "0" prefs key.
  const { hiddenColumns, hideColumn, showColumn } =
    useBoardColumnPrefs(projectId);

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
      kind: std.kind,
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

  // Contribute board context to the shell-mounted ⌘K palette: the selected
  // task (unlocks task-scoped commands) and the commands that need
  // board-mounted dialogs. Everything else the palette needs (projects,
  // users, labels, views, project/view switching) it sources globally.
  const paletteExtraActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "create-project",
        label: "Create project",
        keywords: "new add project",
        handler: () => setCreateProjectOpen(true),
      },
      {
        id: "create-label",
        label: "Create label",
        keywords: "new add label tag",
        handler: () => setLabelManagerOpen(true),
      },
    ],
    [],
  );
  usePalettePageContext(
    useMemo(
      () => ({ selectedTask, extraActions: paletteExtraActions }),
      [selectedTask, paletteExtraActions],
    ),
  );

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

  // Keyboard navigation — arrow keys, Enter, Esc, Space, plus Phase 3's
  // Linear-style modifier moves / priority keys / field-editor keys / help.
  useEffect(() => {
    /** Resolve the concrete `Column` a task should land in for a given
     *  *display* column (which may be a virtual all-projects column). Mirrors
     *  the drag monitor's onDrop resolution below (same virtual→real mapping
     *  by column name), so keyboard moves and drag-and-drop drop into
     *  identical places. */
    function resolveRealColumn(
      displayCol: Column,
      task: Task,
    ): Column | undefined {
      if (displayCol.id > 0) return displayCol;
      const realProject = projects.find((p) => p.id === task.project);
      return realProject?.columns.find((c) => c.name === displayCol.name);
    }

    /** Cmd/Alt+←/→ — move the selected task into the previous/next VISIBLE
     *  column (collapsed columns are skipped), appended at the end of that
     *  column's currently-loaded list. Selection stays on the moved task
     *  since its id doesn't change. */
    function moveTaskAcrossColumns(
      direction: "left" | "right",
      colTaskIds: number[][],
    ) {
      if (!selectedTask) return;
      const ci = colTaskIds.findIndex((ids) => ids.includes(selectedTask.id));
      if (ci === -1) return;
      let ni = direction === "right" ? ci + 1 : ci - 1;
      while (
        ni >= 0 &&
        ni < displayColumns.length &&
        hiddenColumns.has(displayColumns[ni].id)
      ) {
        ni += direction === "right" ? 1 : -1;
      }
      if (ni < 0 || ni >= displayColumns.length) return; // no visible column that way

      const destDisplayCol = displayColumns[ni];
      const targetColumn = resolveRealColumn(destDisplayCol, selectedTask);
      if (!targetColumn) return;

      // Append at the end — if the dest column's loaded list is empty both
      // ids are null, same as dropping into an empty column body.
      const destTasks = tasksByColumn.get(destDisplayCol.id) ?? [];
      const tail = destTasks[destTasks.length - 1];
      moveTask.mutate({
        key: selectedTask.key,
        column_id: targetColumn.id,
        before_id: null,
        after_id: tail?.id ?? null,
        optimistic: {
          destColumn: targetColumn,
          estimatedPosition: tail ? tail.position + 1000 : 1000,
        },
      });
    }

    /** Cmd/Alt+↑/↓ — swap the selected task with its neighbor within the
     *  current column. Note: the Done column sorts by completion time (not
     *  position) while completion-sort is active (see `completionSort` in
     *  ColumnContainer) — the move still persists a new position, but it may
     *  not visibly reorder the column, same tradeoff drag-and-drop already
     *  accepts there. */
    function reorderTaskWithinColumn(
      direction: "up" | "down",
      colTaskIds: number[][],
    ) {
      if (!selectedTask || !selectedTask.column) return;
      const ci = colTaskIds.findIndex((ids) => ids.includes(selectedTask.id));
      if (ci === -1) return;
      const ids = colTaskIds[ci];
      const idx = ids.indexOf(selectedTask.id);
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= ids.length) return; // already at the edge

      const tasks = tasksByColumn.get(displayColumns[ci].id) ?? [];
      let beforeId: number | null;
      let afterId: number | null;
      if (direction === "up") {
        afterId = swapIdx > 0 ? tasks[swapIdx - 1].id : null;
        beforeId = tasks[swapIdx].id;
      } else {
        afterId = tasks[swapIdx].id;
        beforeId = swapIdx + 1 < tasks.length ? tasks[swapIdx + 1].id : null;
      }

      const afterTask = afterId ? tasks.find((t) => t.id === afterId) : undefined;
      const beforeTask = beforeId ? tasks.find((t) => t.id === beforeId) : undefined;
      let estimatedPosition: number;
      if (afterTask && beforeTask) {
        estimatedPosition = (afterTask.position + beforeTask.position) / 2;
      } else if (afterTask) {
        estimatedPosition = afterTask.position + 1000;
      } else if (beforeTask) {
        estimatedPosition = beforeTask.position - 1000;
      } else {
        estimatedPosition = 1000;
      }

      moveTask.mutate({
        key: selectedTask.key,
        column_id: selectedTask.column.id,
        before_id: beforeId,
        after_id: afterId,
        optimistic: { destColumn: selectedTask.column, estimatedPosition },
      });
    }

    /** `d` — move the selected task to its own project's rightmost `is_done`
     *  column. Resolved directly from `task.project` rather than the
     *  currently-displayed virtual column, so — unlike drag-and-drop, which
     *  has to map a *drop target* back to a real column by name — this works
     *  identically on the all-projects board. */
    function moveToDoneColumn() {
      if (!selectedTask) return;
      const realProject = projects.find((p) => p.id === selectedTask.project);
      if (!realProject) return;
      const doneCol = realProject.columns
        .filter((c) => c.is_done)
        .sort((a, b) => b.order - a.order)[0];
      if (!doneCol || doneCol.id === selectedTask.column?.id) return;

      const destKey = isAllProjects
        ? displayColumns.find((c) => c.name === doneCol.name)?.id ?? doneCol.id
        : doneCol.id;
      const destTasks = tasksByColumn.get(destKey) ?? [];
      const tail = destTasks[destTasks.length - 1];
      moveTask.mutate({
        key: selectedTask.key,
        column_id: doneCol.id,
        before_id: null,
        after_id: tail?.id ?? null,
        optimistic: {
          destColumn: doneCol,
          estimatedPosition: tail ? tail.position + 1000 : 1000,
        },
      });
    }

    /** Selecting a task (or deselecting) always closes any open
     *  PropertyPalette — otherwise `openEditor` could keep editing a task
     *  that's no longer selected. */
    function selectTask(id: number | null) {
      setOpenEditor(null);
      setSelectedTaskId(id);
    }

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

      // Skip when the command palette or a dialog is open — those own the
      // keyboard entirely while visible.
      if (
        paletteOpen ||
        taskDialog.isOpen ||
        createProjectOpen ||
        labelManagerOpen ||
        recurringManagerOpen ||
        declutterOpen ||
        helpOpen
      ) {
        return;
      }

      const noModifiers = !e.metaKey && !e.ctrlKey && !e.altKey;

      // While the PropertyPalette is open, its filter input holds focus —
      // the input/textarea/contenteditable check at the top of this handler
      // already makes the board's own keydown inert whenever that's true.
      // This early return just covers the frame before focus lands (or if
      // it's ever lost): the board stops handling keys entirely and leaves
      // Escape/digits/etc to the palette itself (see PropertyPalette).
      if (openEditor !== null) return;

      // Only handle in board view
      if (viewKind !== "board") return;

      // Build column→task arrays from the current server order.
      const colTaskIds: number[][] = displayColumns.map(
        (col) => (tasksByColumn.get(col.id) ?? []).map((t) => t.id),
      );

      // Modifier held (Cmd, or Alt as an alias) + arrow → move/reorder the
      // selected task instead of just changing the selection.
      const moveModifier = e.metaKey || e.altKey;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (moveModifier) {
            reorderTaskWithinColumn("down", colTaskIds);
            return;
          }
          if (selectedTaskId === null) {
            // Select first task of first non-empty column
            for (const ids of colTaskIds) {
              if (ids.length > 0) {
                selectTask(ids[0]);
                return;
              }
            }
            return;
          }
          // Move down within current column
          for (const ids of colTaskIds) {
            const idx = ids.indexOf(selectedTaskId);
            if (idx !== -1 && idx < ids.length - 1) {
              selectTask(ids[idx + 1]);
              return;
            }
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (moveModifier) {
            reorderTaskWithinColumn("up", colTaskIds);
            return;
          }
          if (selectedTaskId === null) return;
          for (const ids of colTaskIds) {
            const idx = ids.indexOf(selectedTaskId);
            if (idx !== -1 && idx > 0) {
              selectTask(ids[idx - 1]);
              return;
            }
          }
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (moveModifier) {
            moveTaskAcrossColumns("right", colTaskIds);
            return;
          }
          if (selectedTaskId === null) {
            // Select first task of first non-empty column
            for (const ids of colTaskIds) {
              if (ids.length > 0) {
                selectTask(ids[0]);
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
                  selectTask(colTaskIds[ni][targetIdx]);
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
          if (moveModifier) {
            moveTaskAcrossColumns("left", colTaskIds);
            return;
          }
          if (selectedTaskId === null) return;
          for (let ci = 0; ci < colTaskIds.length; ci++) {
            const idx = colTaskIds[ci].indexOf(selectedTaskId);
            if (idx !== -1) {
              // Find previous column with tasks
              for (let ni = ci - 1; ni >= 0; ni--) {
                if (colTaskIds[ni].length > 0) {
                  const targetIdx = Math.min(idx, colTaskIds[ni].length - 1);
                  selectTask(colTaskIds[ni][targetIdx]);
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
          selectTask(null);
          break;
        }
        case "0":
        case "1":
        case "2":
        case "3":
        case "4": {
          if (!noModifiers || !selectedTask) return;
          e.preventDefault();
          const next = e.key === "0" ? null : (`P${e.key}` as Priority);
          if (next === selectedTask.priority) return;
          updateTask.mutate({ key: selectedTask.key, priority: next });
          break;
        }
        case "d": {
          if (!noModifiers || !selectedTask) return;
          e.preventDefault();
          moveToDoneColumn();
          break;
        }
        case "p": {
          if (!noModifiers || !selectedTask) return;
          e.preventDefault();
          setOpenEditor("priority");
          break;
        }
        case "a": {
          if (!noModifiers || !selectedTask) return;
          e.preventDefault();
          setOpenEditor("assignee");
          break;
        }
        case "l": {
          if (!noModifiers || !selectedTask) return;
          e.preventDefault();
          setOpenEditor("labels");
          break;
        }
        case "?": {
          if (!noModifiers) return;
          e.preventDefault();
          setHelpOpen(true);
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
    hiddenColumns,
    projects,
    isAllProjects,
    moveTask,
    updateTask,
    openEditor,
    helpOpen,
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
        onSelectProject={setProjectId}
        onCreateProject={() => setCreateProjectOpen(true)}
        viewId={viewId}
        onViewChange={setViewId}
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
        showArchivedToggle={isAllProjects && hasArchivedProjects}
      />
      {/* Applied filters get their own wrapping row — inside the packed
          header they'd collapse to zero width on narrow windows (TAS-040). */}
      <ActiveFilterChips
        filters={boardFilters}
        onFiltersChange={setBoardFilters}
        projects={projects}
        users={allUsers}
        labels={allLabels}
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
        ) : viewId != null && !canSeedForView ? (
          // A view is selected but the views query hasn't resolved yet —
          // hold off on mounting the task queries until we can seed their
          // filters, otherwise we'd fire one round with empty filters and
          // immediately throw it away when the view's filters arrive.
          <div className="h-full" />
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
            {displayColumns.map((col, idx) => (
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
                onEditorOpenRequest={handleEditorOpenRequest}
                onTasksChange={onColumnTasksChange}
                onAddTask={
                  project
                    ? () => taskDialog.createTask({ columnId: col.id })
                    : undefined
                }
                onEditTask={(task) => taskDialog.openTask(task)}
                onDeclutter={() => setDeclutterOpen(true)}
                onAssign={() => setAssignOpen(true)}
                isHidden={hiddenColumns.has(col.id)}
                onHide={() => hideColumn(col.id)}
                onShow={() => showColumn(col.id)}
                manageable={Boolean(project) && col.id > 0}
                canMoveLeft={Boolean(project) && col.id > 0 && idx > 0}
                canMoveRight={
                  Boolean(project) &&
                  col.id > 0 &&
                  idx < displayColumns.length - 1
                }
                onRename={
                  project && col.id > 0
                    ? (name) =>
                        updateColumn.mutate({ id: col.id, name })
                    : undefined
                }
                onSetKind={
                  project && col.id > 0
                    ? (kind) => updateColumn.mutate({ id: col.id, kind })
                    : undefined
                }
                onMove={
                  project && col.id > 0
                    ? (direction) => {
                        const ids = displayColumns
                          .filter((c) => c.id > 0)
                          .map((c) => c.id);
                        const i = ids.indexOf(col.id);
                        if (i < 0) return;
                        const j = direction === "left" ? i - 1 : i + 1;
                        if (j < 0 || j >= ids.length) return;
                        const next = [...ids];
                        [next[i], next[j]] = [next[j], next[i]];
                        reorderColumns.mutate({
                          project: project.id,
                          ordered_ids: next,
                        });
                      }
                    : undefined
                }
                onRequestDelete={
                  project && col.id > 0
                    ? () => setColumnPendingDelete(col)
                    : undefined
                }
              />
            ))}
            {project && (
              <AddColumnCell
                isPending={createColumn.isPending}
                onAdd={(name) =>
                  createColumn.mutate({ project: project.id, name })
                }
              />
            )}
          </div>
        )}
      </div>
      {project && (
        <DeleteColumnDialog
          open={columnPendingDelete !== null}
          column={columnPendingDelete}
          siblings={displayColumns.filter(
            (c) => c.id > 0 && c.id !== columnPendingDelete?.id,
          )}
          taskCount={
            columnPendingDelete
              ? tasksByColumn.get(columnPendingDelete.id)?.length ?? 0
              : 0
          }
          isPending={deleteColumn.isPending}
          onCancel={() => setColumnPendingDelete(null)}
          onConfirm={(moveTasksTo) => {
            if (!columnPendingDelete) return;
            deleteColumn.mutate(
              {
                id: columnPendingDelete.id,
                projectId: project.id,
                moveTasksTo,
              },
              { onSettled: () => setColumnPendingDelete(null) },
            );
          }}
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
      {recurringManagerOpen && (
        <RecurringManager
          projectId={project?.id ?? null}
          projects={projects}
          onClose={() => setRecurringManagerOpen(false)}
        />
      )}
      {openEditor && selectedTask && (
        <PropertyPalette
          task={selectedTask}
          kind={openEditor}
          onClose={() => setOpenEditor(null)}
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
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

const SHORTCUT_ROWS: { keys: string[]; description: string }[] = [
  { keys: ["↑", "↓", "←", "→"], description: "Move selection" },
  { keys: ["Enter"], description: "Open selected task" },
  { keys: ["Esc"], description: "Deselect / close palette" },
  { keys: ["⌘K"], description: "Command palette & search" },
  { keys: ["c"], description: "New task" },
  { keys: ["⌘/Alt", "←", "→"], description: "Move task to prev/next column" },
  { keys: ["⌘/Alt", "↑", "↓"], description: "Reorder task in column" },
  { keys: ["1", "–", "4"], description: "Set priority P1–P4" },
  { keys: ["0"], description: "Clear priority" },
  { keys: ["d"], description: "Move to Done" },
  { keys: ["p"], description: "Edit priority" },
  { keys: ["a"], description: "Edit assignees" },
  { keys: ["l"], description: "Edit labels" },
  { keys: ["?"], description: "Show this help" },
];

/** Compact keyboard-shortcut reference — opened via `?` on the board. Reuses
 *  the same Dialog primitives as the other board dialogs (e.g.
 *  DeleteColumnDialog). Two-column key/description rows only apply while a
 *  task is selected on a kanban (not table) view — see the board's keydown
 *  effect for the guards. */
function ShortcutsHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          {SHORTCUT_ROWS.map((row) => (
            <div
              key={row.description}
              className="flex items-center justify-between gap-3 text-[12px]"
            >
              <span className="text-muted-foreground">{row.description}</span>
              <span className="flex items-center gap-1 shrink-0">
                {row.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded border border-border/60 bg-muted text-[10px] font-mono text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
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
  /** Chip click on any card → select it + open the matching property
   *  palette at the page level (see `handleEditorOpenRequest` above). */
  onEditorOpenRequest: (taskId: number, kind: EditorKind) => void;
  onTasksChange: (columnId: number, tasks: Task[]) => void;
  onAddTask?: () => void;
  onEditTask: (task: Task) => void;
  onDeclutter: () => void;
  onAssign: () => void;
  manageable?: boolean;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  onRename?: (newName: string) => void;
  onSetKind?: (kind: ColumnKind) => void;
  onMove?: (direction: "left" | "right") => void;
  onRequestDelete?: () => void;
  /** Collapsed state, lifted to the board so it can survive this column's
   *  own unmount/remount (e.g. column reorder) and be shared with the
   *  keyboard-nav / drag-monitor's ``tasksByColumn`` map. */
  isHidden?: boolean;
  onHide?: () => void;
  onShow?: () => void;
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
  onEditorOpenRequest,
  onTasksChange,
  onAddTask,
  onEditTask,
  onDeclutter,
  onAssign,
  manageable,
  canMoveLeft,
  canMoveRight,
  onRename,
  onSetKind,
  onMove,
  onRequestDelete,
  isHidden,
  onHide,
  onShow,
}: ColumnContainerProps) {
  // Real columns have positive ids + a concrete `project` fk. All-projects
  // virtual columns have negative ids and only a column name.
  const isVirtual = column.id < 0;
  // Done columns order by completion time (= when the task entered the
  // column), most recent first — but only while the board is on the default
  // manual sort; an explicitly chosen sort applies to every column alike.
  const completionSort =
    column.is_done && (filters.sort[0]?.field ?? "position") === "position";
  const effectiveFilters = useMemo<BoardFilters>(
    () =>
      completionSort
        ? {
            ...filters,
            sort: [{ field: "current_column_since", dir: "desc" }],
          }
        : filters,
    [filters, completionSort],
  );
  // 25 is enough to fill the initial viewport on most screens; the sentinel
  // fetches more on scroll. Halved from 50 to shave initial-load latency
  // when the user has many tasks — a 250-row first paint across five
  // columns was the dominant cost on prod. Collapsed columns only need the
  // total count (surfaced via `page.count` regardless of `limit`), so drop
  // to 1 row to keep the request cheap — the strip never renders cards.
  const query = useTasksInfinite({
    projectId,
    columnId: isVirtual ? null : column.id,
    columnName: isVirtual ? column.name : null,
    filters: effectiveFilters,
    limit: isHidden ? 1 : 25,
  });

  const tasks = useMemo(() => flattenInfinite(query.data), [query.data]);
  const totalCount = query.data?.pages[0]?.count;

  // Collapsed columns report an empty task list to the board so keyboard
  // navigation and the drag monitor skip straight past them — same as an
  // empty column today (e.g. an emptied Backlog already exercises this
  // path in the nav code above).
  useEffect(() => {
    onTasksChange(column.id, isHidden ? [] : tasks);
  }, [column.id, tasks, isHidden, onTasksChange]);

  const fetchNextPage = query.fetchNextPage;
  const handleLoadMore = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  if (isHidden) {
    return (
      <CollapsedColumn column={column} count={totalCount} onExpand={() => onShow?.()} />
    );
  }

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
      isInitialLoading={query.isLoading}
      onAddTask={onAddTask}
      onDeclutter={onDeclutter}
      onAssign={onAssign}
      totalCount={totalCount}
      manageable={manageable}
      canMoveLeft={canMoveLeft}
      canMoveRight={canMoveRight}
      onRename={onRename}
      onSetKind={onSetKind}
      onMove={onMove}
      onRequestDelete={onRequestDelete}
      onHide={onHide}
    >
      {visibleTasks.map((task, idx) => (
        <Fragment key={task.id}>
          {isDest && idx === previewIdx && ghost}
          <DraggableCard task={task} columnId={column.id}>
            {({ isDragging }) => {
              const isSelected = task.id === selectedTaskId;
              return (
                <KanbanCard
                  task={task}
                  isDragging={isDragging}
                  isSelected={isSelected}
                  showProject={isAllProjects}
                  visibleFields={cardDisplay}
                  onClick={() => onEditTask(task)}
                  onEditorOpenRequest={(kind) =>
                    onEditorOpenRequest(task.id, kind)
                  }
                />
              );
            }}
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
      isInitialLoading={query.isLoading}
    />
  );
}

function BoardHeader({
  projects,
  project,
  projectId,
  onSelectProject,
  onCreateProject,
  viewId,
  onViewChange,
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
  showArchivedToggle,
}: {
  projects: Project[];
  project: Project | undefined;
  projectId: number | null;
  onSelectProject: (id: number | null) => void;
  onCreateProject: () => void;
  viewId: number | null;
  onViewChange: (id: number | null) => void;
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
  showArchivedToggle: boolean;
}) {
  const router = useRouter();

  return (
    <header className="shrink-0 h-12 flex items-center gap-1.5 px-4 border-b border-border/80 bg-background">
      {/* Project dropdown — switch active project + jump to settings. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex items-center gap-2 min-w-0 h-8 px-2 -ml-2 rounded-md hover:bg-accent/60 transition-colors shrink-0"
              aria-label="Switch project"
            >
              {project ? (
                <>
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ background: project.color }}
                    aria-hidden
                  />
                  {project.icon && (
                    <span className="text-[13px] leading-none">
                      {project.icon}
                    </span>
                  )}
                  <span className="text-[13px] font-medium truncate">
                    {project.name}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {project.prefix}
                  </span>
                </>
              ) : (
                <>
                  <Layers className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] font-medium">All projects</span>
                </>
              )}
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem
            onClick={() => onSelectProject(null)}
            className={!projectId ? "bg-accent/40" : undefined}
          >
            <Layers className="size-3.5" />
            All projects
          </DropdownMenuItem>
          {projects.length > 0 && <DropdownMenuSeparator />}
          {projects
            .filter((p) => !p.archived)
            .map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => onSelectProject(p.id)}
                className={p.id === projectId ? "bg-accent/40" : undefined}
              >
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ background: p.color }}
                  aria-hidden
                />
                {p.icon && (
                  <span className="text-[13px] leading-none">{p.icon}</span>
                )}
                <span className="truncate flex-1">{p.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {p.prefix}
                </span>
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCreateProject}>
            <Plus className="size-3.5" />
            New project
          </DropdownMenuItem>
          {project && (
            <DropdownMenuItem
              onClick={() => router.push(`/projects/${project.id}`)}
            >
              <Settings className="size-3.5" />
              Settings for {project.name}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {project?.github_repo && (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={`https://github.com/${project.github_repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 size-7 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors shrink-0"
                aria-label={`Open ${project.github_repo} on GitHub`}
              >
                <GitBranch className="size-3.5" />
              </a>
            }
          />
          <TooltipContent>
            <span className="font-mono text-[11px]">{project.github_repo}</span>
          </TooltipContent>
        </Tooltip>
      )}
      <div className="h-5 w-px bg-border mx-0.5 shrink-0" />

      {/* View switcher — saved filter+sort presets, lives next to the project. */}
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
        showArchivedToggle={showArchivedToggle}
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
