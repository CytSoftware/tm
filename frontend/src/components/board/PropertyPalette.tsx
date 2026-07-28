"use client";

import { Check } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { UserAvatar } from "@/components/UserAvatar";
import { useUpdateTask } from "@/hooks/use-tasks";
import { useUsersQuery } from "@/hooks/use-users";
import { useLabelsQuery } from "@/hooks/use-labels";
import { cn } from "@/lib/utils";
import { PRIORITY_DOT, PRIORITY_LABELS, PRIORITY_ORDER } from "@/lib/types";
import type { Priority, Task } from "@/lib/types";
import type { EditorKind } from "@/components/kanban/Card";

type Props = {
  task: Task;
  kind: EditorKind;
  onClose: () => void;
};

const TITLE: Record<EditorKind, string> = {
  priority: "Change priority",
  assignee: "Assign to",
  labels: "Change labels",
};

const PLACEHOLDER: Record<EditorKind, string> = {
  priority: "Change priority to…",
  assignee: "Assign to…",
  labels: "Change labels…",
};

/** Square kbd badge for the priority row's number-shortcut hint — same
 *  border/bg/font as the board's shortcut-help kbd (see SHORTCUT_ROWS in
 *  board/page.tsx), just squared off and right-aligned per row instead of in
 *  a two-column help list. Rendered through `CommandShortcut` (rather than a
 *  bare span) so its `data-slot="command-shortcut"` hides `CommandItem`'s own
 *  built-in trailing checkmark — we render our own explicit one instead,
 *  positioned to the left of the kbd, since a value can be both current *and*
 *  have a digit hint. */
function KbdHint({ children }: { children: React.ReactNode }) {
  return (
    <CommandShortcut className="ml-0 flex size-5 shrink-0 max-lg:hidden items-center justify-center rounded border border-border/60 bg-muted font-mono text-[10px] tracking-normal text-muted-foreground">
      {children}
    </CommandShortcut>
  );
}

/**
 * Linear-style centered command palette for editing one property (priority /
 * assignee / labels) of a single task — replaces the old per-chip anchored
 * popovers on `KanbanCard`. Always mounted with `open` true; unmounting is
 * the caller's job (see `openEditor` state in board/page.tsx).
 *
 * Priority is a single pick — selecting one applies and closes. Assignees
 * and labels are multi-select — selecting toggles membership and leaves the
 * palette open for further picks, matching the checkbox-list behavior the
 * old chip popovers had.
 */
export function PropertyPalette({ task, kind, onClose }: Props) {
  const updateTask = useUpdateTask();
  const usersQuery = useUsersQuery();
  const allUsers = usersQuery.data ?? [];
  const labelsQuery = useLabelsQuery();
  // Labels selectable for this task: global labels plus ones scoped to the
  // task's own project — mirrors the scope rule the backend enforces in
  // TaskUpdateSerializer (same filter the old card chip used).
  const availableLabels = (labelsQuery.data ?? []).filter(
    (l) => l.project == null || l.project === task.project,
  );

  function applyPriority(next: Priority | null) {
    if (next !== task.priority) {
      updateTask.mutate({ key: task.key, priority: next });
    }
    onClose();
  }

  function toggleAssignee(id: number) {
    const current = task.assignees.map((u) => u.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    updateTask.mutate({
      key: task.key,
      assignee_ids: next,
      optimisticAssignees: allUsers.filter((u) => next.includes(u.id)),
    });
  }

  function toggleLabel(id: number) {
    const current = task.labels.map((l) => l.id);
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    updateTask.mutate({
      key: task.key,
      label_ids: next,
      optimisticLabels: availableLabels.filter((l) => next.includes(l.id)),
    });
  }

  // Digit shortcuts (priority kind only) — 0 clears, 1-4 pick P1-P4,
  // regardless of any filter text already typed. `preventDefault` stops
  // cmdk's own root keydown switch (it bails on `e.defaultPrevented`) so the
  // digit never lands in the filter input.
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (kind !== "priority") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!["0", "1", "2", "3", "4"].includes(e.key)) return;
    e.preventDefault();
    applyPriority(e.key === "0" ? null : (`P${e.key}` as Priority));
  }

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={TITLE[kind]}
      description={PLACEHOLDER[kind]}
      className="sm:max-w-lg"
    >
      <Command>
        {/* Task-context pill — mirrors the card footer's key styling. */}
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 min-w-0">
          <span className="inline-flex items-center gap-1.5 max-w-full min-w-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[12px] text-muted-foreground">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground/80 shrink-0">
              {task.key}
            </span>
            <span className="shrink-0 text-muted-foreground/50">·</span>
            <span className="truncate">{task.title}</span>
          </span>
        </div>

        <CommandInput
          autoFocus={
            typeof window === "undefined" ||
            window.matchMedia("(pointer: fine)").matches
          }
          placeholder={PLACEHOLDER[kind]}
          onKeyDown={handleInputKeyDown}
        />

        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>

          {kind === "priority" && (
            <CommandGroup>
              <CommandItem value="No priority" onSelect={() => applyPriority(null)}>
                <span className="size-2 rounded-full border border-dashed border-muted-foreground/50 shrink-0" />
                <span className="flex-1 truncate">No priority</span>
                {task.priority == null && (
                  <Check className="size-3 text-muted-foreground shrink-0" />
                )}
                <KbdHint>0</KbdHint>
              </CommandItem>
              {PRIORITY_ORDER.map((p, i) => (
                <CommandItem key={p} value={p} onSelect={() => applyPriority(p)}>
                  <span
                    className={cn("size-2 rounded-full shrink-0", PRIORITY_DOT[p])}
                  />
                  <span className="flex-1 truncate">{PRIORITY_LABELS[p]}</span>
                  {task.priority === p && (
                    <Check className="size-3 text-muted-foreground shrink-0" />
                  )}
                  <KbdHint>{i + 1}</KbdHint>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {kind === "assignee" && (
            <CommandGroup>
              {allUsers.map((u) => {
                const isAssigned = task.assignees.some((a) => a.id === u.id);
                return (
                  <CommandItem
                    key={u.id}
                    value={u.username}
                    onSelect={() => toggleAssignee(u.id)}
                  >
                    <UserAvatar
                      username={u.username}
                      avatarUrl={u.avatar_url}
                      size="size-4"
                    />
                    <span className="flex-1 truncate">{u.username}</span>
                    {isAssigned && (
                      <Check className="size-3 text-muted-foreground shrink-0" />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {kind === "labels" && (
            <CommandGroup>
              {availableLabels.map((l) => {
                const isApplied = task.labels.some((x) => x.id === l.id);
                return (
                  <CommandItem
                    key={l.id}
                    value={l.name}
                    onSelect={() => toggleLabel(l.id)}
                  >
                    <span
                      className="size-2 rounded-full shrink-0"
                      style={{ background: l.color }}
                    />
                    <span className="flex-1 truncate">{l.name}</span>
                    {isApplied && (
                      <Check className="size-3 text-muted-foreground shrink-0" />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
