"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Column } from "@/lib/types";

type Props = {
  open: boolean;
  column: Column | null;
  siblings: Column[];
  taskCount: number;
  isPending?: boolean;
  onCancel: () => void;
  onConfirm: (moveTasksTo: number | undefined) => void;
};

export function DeleteColumnDialog({
  open,
  column,
  siblings,
  taskCount,
  isPending,
  onCancel,
  onConfirm,
}: Props) {
  const [target, setTarget] = useState<string>("");
  const [wasOpen, setWasOpen] = useState(false);
  // On the false→true transition, default the target to the leftmost active
  // (non-done) sibling. Done in render via the "previous render info" pattern
  // so the dropdown has a value before paint. Resets on close so reopening
  // re-evaluates the default.
  if (open && !wasOpen) {
    setWasOpen(true);
    const def = siblings.find((c) => !c.is_done) ?? siblings[0];
    setTarget(def ? String(def.id) : "");
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  if (!column) return null;

  const requiresTarget = taskCount > 0;
  const canConfirm = !requiresTarget || target !== "";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{column.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            {requiresTarget ? (
              <>
                This column has {taskCount} task{taskCount === 1 ? "" : "s"}.
                Choose another column to move {taskCount === 1 ? "it" : "them"}{" "}
                into before deleting.
              </>
            ) : (
              "This column is empty and will be removed from the project."
            )}
          </DialogDescription>
        </DialogHeader>
        {requiresTarget && (
          <div className="space-y-2">
            <Select
              value={target}
              onValueChange={(v) => setTarget(v ?? "")}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Move tasks to…" />
              </SelectTrigger>
              <SelectContent>
                {siblings.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm || isPending}
            onClick={() =>
              onConfirm(
                requiresTarget && target ? Number(target) : undefined,
              )
            }
          >
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
