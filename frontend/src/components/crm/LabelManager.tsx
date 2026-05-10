"use client";

/**
 * Compact popover for creating, renaming, and deleting contact labels.
 *
 * Surfaced from the CRM page header so the user can extend the preset list
 * without leaving the table.
 */

import { useState } from "react";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useContactLabelsQuery,
  useCreateContactLabel,
  useDeleteContactLabel,
  useUpdateContactLabel,
} from "@/hooks/use-contacts";
import type { ContactLabel } from "@/lib/types";
import { cn } from "@/lib/utils";

const SWATCHES = [
  "#3b82f6",
  "#a855f7",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
  "#84cc16",
  "#6b7280",
];

export function LabelManager() {
  const labelsQuery = useContactLabelsQuery();
  const createLabel = useCreateContactLabel();
  const updateLabel = useUpdateContactLabel();
  const deleteLabel = useDeleteContactLabel();

  const [name, setName] = useState("");
  const [color, setColor] = useState(SWATCHES[0]);
  const [editing, setEditing] = useState<ContactLabel | null>(null);

  function reset() {
    setName("");
    setColor(SWATCHES[0]);
    setEditing(null);
  }

  function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (editing) {
      updateLabel.mutate(
        { id: editing.id, name: trimmed, color },
        { onSuccess: reset },
      );
    } else {
      createLabel.mutate({ name: trimmed, color }, { onSuccess: reset });
    }
  }

  function handleEdit(label: ContactLabel) {
    setEditing(label);
    setName(label.name);
    setColor(label.color);
  }

  function handleDelete(label: ContactLabel) {
    if (
      !confirm(
        `Delete label "${label.name}"? It will be detached from all contacts.`,
      )
    )
      return;
    deleteLabel.mutate(label.id);
    if (editing?.id === label.id) reset();
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-8 gap-1.5">
            <Tags className="size-3.5" />
            <span>Labels</span>
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-3 space-y-3">
        <div className="space-y-2">
          <Input
            placeholder={editing ? "Rename label…" : "New label name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            className="h-8 text-[12px]"
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "size-5 rounded-full border-2",
                  color === c ? "border-foreground" : "border-transparent",
                )}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-7"
              onClick={handleSubmit}
              disabled={
                !name.trim() || createLabel.isPending || updateLabel.isPending
              }
            >
              <Plus className="size-3.5" />
              {editing ? "Save" : "Add"}
            </Button>
            {editing && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={reset}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>

        <div className="border-t border-border/60 pt-2 space-y-1 max-h-56 overflow-y-auto">
          {(labelsQuery.data ?? []).map((l) => (
            <div
              key={l.id}
              className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/60"
            >
              <span
                className="size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: l.color }}
              />
              <span className="text-[12px] flex-1 truncate">{l.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => handleEdit(l)}
                aria-label="Edit label"
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => handleDelete(l)}
                aria-label="Delete label"
              >
                <Trash2 className="size-3 text-destructive" />
              </Button>
            </div>
          ))}
          {(labelsQuery.data ?? []).length === 0 && (
            <div className="text-[12px] text-muted-foreground italic px-1.5">
              No labels yet.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
