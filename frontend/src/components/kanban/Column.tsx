"use client";

import { KeyboardEvent, ReactNode, Ref, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
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
    <div className="flex-1 min-w-[200px] h-full flex flex-col min-h-0">
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
          {manageable && (
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
      <div className="shrink-0 w-[220px] h-full flex items-start pt-1">
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
    <div className="shrink-0 w-[220px] h-full flex items-start pt-1">
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
