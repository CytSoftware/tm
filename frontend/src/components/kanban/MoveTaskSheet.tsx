"use client";

import { Check } from "lucide-react";

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Column, Task } from "@/lib/types";

type MoveTaskSheetProps = {
  task: Task | null;
  columns: Column[];
  onMove: (task: Task, destColumn: Column) => void;
  onClose: () => void;
};

/**
 * "Move to…" bottom sheet — the touch path for changing a task's column.
 *
 * The board's drag-and-drop is `@atlaskit/pragmatic-drag-and-drop`'s element
 * adapter, which is built on the **native HTML5 drag API**. That API never
 * fires from touch input, so before TAS-061 there was no way at all to move a
 * card on a phone short of opening the task panel and changing the Status
 * select. Opened by long-pressing a card.
 */
export function MoveTaskSheet({
  task,
  columns,
  onMove,
  onClose,
}: MoveTaskSheetProps) {
  // The task's column is a real column; on the all-projects board the display
  // columns are virtual, so match on name as well as id.
  const currentId = task?.column?.id ?? null;
  const currentName = task?.column?.name ?? null;

  return (
    <Sheet
      open={task != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="bottom" className="lg:hidden">
        <SheetHeader>
          <SheetTitle className="truncate">
            Move {task?.key ?? "task"}
          </SheetTitle>
          <p className="text-[12px] text-muted-foreground truncate">
            {task?.title}
          </p>
        </SheetHeader>
        <SheetBody className="px-2 pb-2">
          {columns.map((col) => {
            const isCurrent =
              col.id > 0 ? col.id === currentId : col.name === currentName;
            return (
              <button
                key={col.id}
                disabled={isCurrent}
                onClick={() => {
                  if (task) onMove(task, col);
                  onClose();
                }}
                className={cn(
                  "w-full flex items-center gap-2.5 rounded-md px-3 py-3 text-left text-[14px]",
                  isCurrent
                    ? "text-muted-foreground"
                    : "hover:bg-accent active:bg-accent",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full shrink-0",
                    col.is_done ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                />
                <span className="flex-1 min-w-0 truncate">{col.name}</span>
                {isCurrent && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px]">
                    <Check className="size-3.5" />
                    Current
                  </span>
                )}
              </button>
            );
          })}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
