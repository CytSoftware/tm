"use client";

/**
 * A task's comment thread as a collapsible section of the panel's left
 * sidebar, styled like the History section below it. Oldest first, composer
 * last. Authors can edit or delete their own comments (the server enforces it
 * too). The project socket's `task.commented` event keeps other open panels in
 * sync (see `lib/ws.ts`).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/UserAvatar";
import { formatDuration } from "./TimeInColumn";
import { apiFetch } from "@/lib/api";
import { taskCommentsKey } from "@/lib/query-keys";
import type { TaskComment } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TaskComments({
  taskKey,
  count,
  meId,
}: {
  taskKey: string;
  /** From the task row, so the collapsed header can show it without a fetch. */
  count: number;
  meId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: taskCommentsKey(taskKey),
    queryFn: () =>
      apiFetch<TaskComment[]>(`/api/tasks/${taskKey}/comments/`),
    enabled: open,
  });
  const comments = query.data ?? [];
  const shown = query.data ? comments.length : count;

  const base = `/api/tasks/${taskKey}/comments/`;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: taskCommentsKey(taskKey) });
    // The board card and this header show the count.
    void queryClient.invalidateQueries({ queryKey: ["tasks-infinite"] });
  };
  const add = useMutation({
    mutationFn: (body: string) =>
      apiFetch<TaskComment>(base, { method: "POST", body: { body } }),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) =>
      apiFetch<TaskComment>(`${base}${id}/`, { method: "PATCH", body: { body } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`${base}${id}/`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 w-full px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="uppercase tracking-wide">Comments</span>
        {shown > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
            {shown}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 pl-5 pr-1 space-y-2.5">
          {query.isLoading && (
            <p className="text-[11px] text-muted-foreground">Loading...</p>
          )}
          {comments.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              mine={c.author.id === meId}
              onEdit={(body) => edit.mutateAsync({ id: c.id, body })}
              onDelete={() => {
                if (confirm("Delete this comment?")) remove.mutate(c.id);
              }}
            />
          ))}
          <Composer
            placeholder="Add a comment…"
            submitLabel="Comment"
            pending={add.isPending}
            onSubmit={(body) => add.mutateAsync(body)}
          />
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  mine,
  onEdit,
  onDelete,
}: {
  comment: TaskComment;
  mine: boolean;
  onEdit: (body: string) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="group text-[11px] leading-tight">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <UserAvatar
          username={comment.author.username}
          avatarUrl={comment.author.avatar_url}
          size="size-4"
        />
        <span className="font-medium text-foreground truncate">
          {comment.author.username}
        </span>
        <span
          className="shrink-0"
          title={new Date(comment.created_at).toLocaleString()}
        >
          {formatDuration(comment.created_at)} ago
        </span>
        {comment.edited_at && (
          <span
            className="shrink-0"
            title={`Edited ${new Date(comment.edited_at).toLocaleString()}`}
          >
            (edited)
          </span>
        )}
        {mine && !editing && (
          <span className="ml-auto flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover-none:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon"
              className="size-5 tap-target"
              title="Edit"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 tap-target text-destructive hover:text-destructive"
              title="Delete"
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          className="mt-1"
          initial={comment.body}
          submitLabel="Save"
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await onEdit(body);
            setEditing(false);
          }}
        />
      ) : (
        <p className="mt-1 text-[12px] leading-snug text-foreground whitespace-pre-wrap break-words">
          {comment.body}
        </p>
      )}
    </div>
  );
}

/** Textarea + submit. ⌘/Ctrl+Enter submits and Escape cancels — both stop
 *  propagation so the panel's own document-level shortcuts (save, close)
 *  don't also fire. */
function Composer({
  initial = "",
  placeholder,
  submitLabel,
  pending,
  autoFocus,
  className,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  pending?: boolean;
  autoFocus?: boolean;
  className?: string;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const canSubmit = !!body.trim() && !busy && !pending;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(body.trim());
      setBody("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("space-y-1", className)}>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="min-h-[3rem] px-2 py-1.5 text-[12px] resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            void submit();
          } else if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {(body.trim() || onCancel) && (
        <div className="flex justify-end gap-1">
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? "Saving..." : submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
