"use client";

import { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Plus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Column, Task } from "@/lib/types";

type Props = {
  column: Column;
  tasks: Task[];
  children: ReactNode;
  onAddTask?: () => void;
  /** Tinder-style backlog triage. Renders a button only when the column is
   *  named "Backlog" — parent passes the same handler to every column and
   *  this component decides whether to show it. */
  onDeclutter?: () => void;
};

export function KanbanColumn({
  column,
  tasks,
  children,
  onAddTask,
  onDeclutter,
}: Props) {
  // Make the column body a droppable so empty columns still accept drops.
  const { setNodeRef, isOver } = useDroppable({
    id: `col-${column.id}`,
  });

  return (
    <div className="flex-1 min-w-[200px] h-full flex flex-col min-h-0">
      <header className="shrink-0 flex items-center justify-between gap-2 px-1 py-1.5 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "size-1.5 rounded-full",
              column.is_done ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          <span className="text-[13px] font-medium tracking-tight truncate">
            {column.name}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {tasks.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
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
        </div>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "scrollbar-none flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 rounded-md transition-colors",
          isOver && "bg-accent/40",
        )}
      >
        {children}
      </div>
    </div>
  );
}
