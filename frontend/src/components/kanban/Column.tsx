"use client";

import { KeyboardEvent, ReactNode, Ref, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Column, Task } from "@/lib/types";

type Props = {
  column: Column;
  tasks: Task[];
  children: ReactNode;
  onAddTask?: () => void;
  onDeclutter?: () => void;
  onAssign?: () => void;
  bodyRef?: Ref<HTMLDivElement>;
  isDraggingOver?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  totalCount?: number;
  /** When true, show rename / done-toggle / move / delete affordances. The
   *  parent only enables this for real (single-project) columns — virtual
   *  all-projects columns aren't editable. */
  manageable?: boolean;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  onRename?: (newName: string) => void;
  onToggleDone?: () => void;
  onMove?: (direction: "left" | "right") => void;
  onRequestDelete?: () => void;
  /** Collapses the column into a thin strip. Offered on every column
   *  (including the non-``manageable`` virtual all-projects ones) as long as
   *  a handler is passed. */
  onHide?: () => void;
};

export function KanbanColumn({
  column,
  tasks,
  children,
  onAddTask,
  onDeclutter,
  onAssign,
  bodyRef,
  isDraggingOver,
  hasMore,
  isLoadingMore,
  onLoadMore,
  totalCount,
  manageable,
  canMoveLeft,
  canMoveRight,
  onRename,
  onToggleDone,
  onMove,
  onRequestDelete,
  onHide,
}: Props) {
  const displayCount = totalCount ?? tasks.length;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(column.name);
  const [prevName, setPrevName] = useState(column.name);
  // Reset the rename draft when the underlying column name changes (e.g. a
  // collaborator renamed it). Uses the "store info from previous renders"
  // pattern instead of an effect so the state stays in sync within one render.
  if (prevName !== column.name) {
    setPrevName(column.name);
    setDraftName(column.name);
  }

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isLoadingMore) {
            onLoadMore();
          }
        }
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore]);

  function commitRename() {
    const next = draftName.trim();
    if (!next || next === column.name) {
      setIsRenaming(false);
      setDraftName(column.name);
      return;
    }
    onRename?.(next);
    setIsRenaming(false);
  }

  function onRenameKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsRenaming(false);
      setDraftName(column.name);
    }
  }

  return (
    <div className="flex-1 min-w-[300px] h-full flex flex-col min-h-0">
      <header className="shrink-0 flex items-center justify-between gap-2 px-1 py-1.5 mb-1">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className={cn(
              "size-1.5 rounded-full shrink-0",
              column.is_done ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          {isRenaming ? (
            <Input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={onRenameKey}
              className="h-6 px-1.5 text-[13px] font-medium tracking-tight"
            />
          ) : (
            <>
              <span
                className={cn(
                  "text-[13px] font-medium tracking-tight truncate",
                  manageable && "cursor-text",
                )}
                onDoubleClick={() => manageable && setIsRenaming(true)}
                title={manageable ? "Double-click to rename" : undefined}
              >
                {column.name}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {displayCount}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {onDeclutter && column.name === "Backlog" && tasks.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onDeclutter();
              }}
              aria-label="Declutter backlog"
              title="Declutter backlog"
            >
              <Sparkles className="size-3.5" />
            </Button>
          )}
          {onAssign && column.name === "Todo" && tasks.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onAssign();
              }}
              aria-label="Assign Todo tasks"
              title="Assign Todo tasks"
            >
              <UserPlus className="size-3.5" />
            </Button>
          )}
          {onAddTask && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onAddTask();
              }}
              aria-label={`Add task to ${column.name}`}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
          {(manageable || onHide) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    aria-label={`Column ${column.name} options`}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-44">
                {manageable && (
                  <>
                    <DropdownMenuItem onClick={() => setIsRenaming(true)}>
                      <Pencil className="size-3.5" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onToggleDone?.()}>
                      {column.is_done ? (
                        <CircleDashed className="size-3.5" />
                      ) : (
                        <CircleCheck className="size-3.5" />
                      )}
                      {column.is_done ? "Unmark as done" : "Mark as done"}
                    </DropdownMenuItem>
                  </>
                )}
                {onHide && (
                  <DropdownMenuItem onClick={() => onHide()}>
                    <EyeOff className="size-3.5" />
                    Hide column
                  </DropdownMenuItem>
                )}
                {manageable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => onMove?.("left")}
                      disabled={!canMoveLeft}
                    >
                      <ArrowLeft className="size-3.5" />
                      Move left
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onMove?.("right")}
                      disabled={!canMoveRight}
                    >
                      <ArrowRight className="size-3.5" />
                      Move right
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => onRequestDelete?.()}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      Delete column
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      <div
        ref={bodyRef}
        className={cn(
          "scrollbar-none flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 rounded-md transition-colors",
          isDraggingOver && "bg-accent/40",
        )}
      >
        {children}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="shrink-0 py-2 text-center text-[11px] text-muted-foreground"
          >
            {isLoadingMore ? "Loading…" : " "}
          </div>
        )}
      </div>
    </div>
  );
}

type CollapsedColumnProps = {
  column: Column;
  /** Task count for the column — undefined while the (``limit: 1``) count
   *  query is still loading, in which case we just show a blank instead of
   *  flashing a stale/zero value. */
  count?: number;
  onExpand: () => void;
};

/** Linear-style collapsed column: a thin full-height strip with the column
 *  name rendered vertically + a task count. Clicking anywhere re-expands.
 *  Not wired up as a drag-and-drop target — dropping a card directly onto a
 *  collapsed column isn't supported (see board/page.tsx ColumnContainer). */
export function CollapsedColumn({ column, count, onExpand }: CollapsedColumnProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onExpand}
            aria-label={`Show column ${column.name}`}
            className="shrink-0 w-10 h-full flex flex-col items-center gap-2 pt-3 pb-2 rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                column.is_done ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            <span className="text-[11px] tabular-nums shrink-0">
              {count ?? " "}
            </span>
            <span className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
              <span className="text-[12px] font-medium tracking-tight [writing-mode:vertical-rl] rotate-180 truncate">
                {column.name}
              </span>
            </span>
          </button>
        }
      />
      <TooltipContent side="right">Show column</TooltipContent>
    </Tooltip>
  );
}

type AddColumnCellProps = {
  onAdd: (name: string) => void;
  isPending?: boolean;
};

/** Empty-state column rendered to the right of the last real column.
 *  Click → input → Enter creates the new column. Esc cancels. */
export function AddColumnCell({ onAdd, isPending }: AddColumnCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function commit() {
    const next = draft.trim();
    if (!next) {
      setIsEditing(false);
      setDraft("");
      return;
    }
    onAdd(next);
    setDraft("");
    setIsEditing(false);
  }

  if (!isEditing) {
    return (
      <div className="shrink-0 w-[240px] h-full flex items-start pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={() => setIsEditing(true)}
          disabled={isPending}
        >
          <Plus className="size-3.5" />
          Add column
        </Button>
      </div>
    );
  }

  return (
    <div className="shrink-0 w-[240px] h-full flex items-start pt-1">
      <div className="flex w-full items-center gap-1">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setIsEditing(false);
              setDraft("");
            }
          }}
          placeholder="Column name"
          className="h-8 text-[13px]"
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={commit}
          disabled={isPending || !draft.trim()}
          aria-label="Create column"
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => {
            setIsEditing(false);
            setDraft("");
          }}
          aria-label="Cancel"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
