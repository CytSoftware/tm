"use client";

/**
 * Shared task-editing pickers — the single source of the assignee / label /
 * priority selection UI, used by both the TaskPanel property sidebar and the
 * kanban card's inline chip editors (`components/kanban/Card.tsx`).
 *
 * Each "thing" is split into a bare checkbox list (no Popover — the caller
 * owns that, since the panel and the card use very different triggers) plus
 * a "full" `*Picker` component that wraps the list in the panel's
 * chips-row + "+ Add ..." trigger UI. The card reuses the bare lists behind
 * its own trigger (the chip itself) so the two surfaces can't drift apart.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ColorPicker, PRESET_COLORS } from "@/components/ui/ColorPicker";
import { UserAvatar } from "@/components/UserAvatar";
import { apiFetch } from "@/lib/api";
import type { Label as LabelType, Priority, User } from "@/lib/types";
import { PRIORITY_DOT, PRIORITY_LABELS, PRIORITY_ORDER } from "@/lib/types";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------- */
/* Assignees                                                             */
/* -------------------------------------------------------------------- */

/** Checkbox rows for picking users. No Popover wrapper — callers own it. */
export function AssigneeCheckboxList({
  available,
  selected,
  onToggle,
}: {
  available: User[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  if (available.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
        No users available.
      </p>
    );
  }
  return (
    <>
      {available.map((u) => (
        <button
          key={u.id}
          type="button"
          onClick={() => onToggle(u.id)}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-accent transition-colors"
        >
          <Checkbox checked={selected.includes(u.id)} />
          <UserAvatar
            username={u.username}
            avatarUrl={u.avatar_url}
            size="size-4"
          />
          {u.username}
        </button>
      ))}
    </>
  );
}

/** Full assignee editor for the task panel sidebar: a removable chip row for
 *  the current selection, plus a "+ Add assignee" trigger that opens the
 *  checkbox list. */
export function AssigneePicker({
  available,
  selected,
  onChange,
}: {
  available: User[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  if (available.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground pl-1">
        No users available.
      </p>
    );
  }

  function toggle(id: number) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  }

  const selectedUsers = available.filter((u) => selected.includes(u.id));

  return (
    <div className="space-y-1.5">
      {selectedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedUsers.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u.id)}
              className="inline-flex items-center gap-1 rounded-full bg-accent/60 hover:bg-accent pl-0.5 pr-1.5 py-0.5 text-[11px] transition-colors"
              title={`Unassign ${u.username}`}
            >
              <UserAvatar
                username={u.username}
                avatarUrl={u.avatar_url}
                size="size-4"
              />
              {u.username}
              <X className="size-2.5 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px] text-muted-foreground w-full justify-start"
            >
              + Add assignee
            </Button>
          }
        />
        <PopoverContent className="w-52 p-1" align="start">
          <AssigneeCheckboxList
            available={available}
            selected={selected}
            onToggle={toggle}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Labels                                                                */
/* -------------------------------------------------------------------- */

/** Checkbox rows for picking labels. No Popover wrapper — callers own it. */
export function LabelCheckboxList({
  available,
  selected,
  onToggle,
}: {
  available: LabelType[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  if (available.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
        No labels yet.
      </p>
    );
  }
  return (
    <>
      {available.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => onToggle(l.id)}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-accent transition-colors"
        >
          <Checkbox checked={selected.includes(l.id)} />
          <span
            className="size-2 rounded-full"
            style={{ background: l.color }}
          />
          {l.name}
        </button>
      ))}
    </>
  );
}

/** Full label editor for the task panel sidebar: a removable badge row for
 *  the current selection, a "+ Add label" trigger that opens the checkbox
 *  list, and an inline "create new label" form at the bottom of the list. */
export function LabelPicker({
  available,
  selected,
  onChange,
  projectId,
}: {
  available: LabelType[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** Project scope for newly-created labels. `null` = global (Inbox). */
  projectId: number | null;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(PRESET_COLORS[10]);

  const createLabel = useMutation({
    mutationFn: (payload: {
      project: number | null;
      name: string;
      color: string;
    }) =>
      apiFetch<LabelType>("/api/labels/", { method: "POST", body: payload }),
    onSuccess: (label) => {
      // Invalidate every labels query so both the project-scoped and the
      // global ("global") cache entries refetch — the new label might be
      // visible in either depending on its project scope.
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      onChange([...selected, label.id]);
      setNewName("");
      setCreating(false);
    },
  });

  function toggle(id: number) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  }

  function handleCreate() {
    const name = newName.trim();
    if (!name || createLabel.isPending) return;
    createLabel.mutate({ project: projectId, name, color: newColor });
  }

  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {available
            .filter((l) => selected.includes(l.id))
            .map((l) => (
              <Badge
                key={l.id}
                variant="outline"
                className="text-[10px] h-5 cursor-pointer"
                style={{
                  background: `${l.color}22`,
                  color: l.color,
                  borderColor: `${l.color}44`,
                }}
                onClick={() => toggle(l.id)}
              >
                {l.name} ×
              </Badge>
            ))}
        </div>
      )}
      <Popover
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setNewName("");
          }
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px] text-muted-foreground w-full justify-start"
            >
              + Add label
            </Button>
          }
        />
        <PopoverContent className="w-60 p-1" align="start">
          <LabelCheckboxList
            available={available}
            selected={selected}
            onToggle={toggle}
          />

          <div className="mt-1 border-t border-border/60 pt-1">
            {creating ? (
              <div className="px-2 py-1.5 space-y-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  autoFocus
                  placeholder="Label name"
                  className="h-7 text-[12px]"
                />
                <ColorPicker value={newColor} onChange={setNewColor} />
                {createLabel.isError && (
                  <p className="text-[10px] text-destructive">
                    Couldn’t create label. Name may already be taken.
                  </p>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {projectId == null ? "Global" : "Project-scoped"}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => {
                        setCreating(false);
                        setNewName("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={handleCreate}
                      disabled={!newName.trim() || createLabel.isPending}
                    >
                      {createLabel.isPending ? "Adding…" : "Create"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                + Create new label
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Priority                                                              */
/* -------------------------------------------------------------------- */

/** Rows for picking a single priority (or clearing it). No Popover wrapper —
 *  callers own it. Used by the kanban card's inline priority chip; the task
 *  panel sidebar uses a plain `<Select>` instead since it isn't a popover
 *  UI there. */
export function PriorityMenu({
  value,
  onSelect,
}: {
  value: Priority | null;
  onSelect: (next: Priority | null) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-accent transition-colors"
      >
        <span className="size-2 rounded-full border border-dashed border-muted-foreground/50" />
        No priority
        {value == null && (
          <Check className="size-3 ml-auto text-muted-foreground" />
        )}
      </button>
      {PRIORITY_ORDER.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onSelect(p)}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-accent transition-colors",
          )}
        >
          <span className={cn("size-2 rounded-full", PRIORITY_DOT[p])} />
          {PRIORITY_LABELS[p]}
          {value === p && (
            <Check className="size-3 ml-auto text-muted-foreground" />
          )}
        </button>
      ))}
    </>
  );
}
