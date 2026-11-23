"use client";

/**
 * A task's comment thread, oldest first, with a composer at the bottom.
 * Authors can edit or delete their own comments (the server enforces it too).
 * `@username` mentions are highlighted here; the server parses them and
 * notifies the mentioned users. The project socket's `task.commented` event
 * keeps other open panels in sync (see `lib/ws.ts`).
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/UserAvatar";
import { formatDuration } from "./TimeInColumn";
import { useUsersQuery } from "@/hooks/use-users";
import { apiFetch } from "@/lib/api";
import { taskCommentsKey } from "@/lib/query-keys";
import type { TaskComment } from "@/lib/types";
import { cn } from "@/lib/utils";

// Same shape the backend parses (apps/tasks/comments.py MENTION_RE).
const MENTION_RE = /(^|[^\w@])@([\w.+-]+)/g;

export function TaskComments({
  taskKey,
  meId,
}: {
  taskKey: string;
  meId: number | null;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: taskCommentsKey(taskKey),
    queryFn: () =>
      apiFetch<TaskComment[]>(`/api/tasks/${taskKey}/comments/`),
  });
  const comments = query.data ?? [];

  const base = `/api/tasks/${taskKey}/comments/`;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: taskCommentsKey(taskKey) });
    // The board card shows the count.
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

  // Keep the newest comment in view when the thread grows.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments.length]);

  return (
    <div className="shrink-0 max-h-[45%] min-h-0 flex flex-col border-t border-border/60 px-6 pt-3 pb-4 max-lg:order-4 max-lg:max-h-none max-lg:px-4">
      <div className="shrink-0 flex items-center gap-1.5 pb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <MessageSquare className="size-3" />
        Comments
        {comments.length > 0 && (
          <span className="tabular-nums normal-case">· {comments.length}</span>
        )}
      </div>

      <div
        ref={listRef}
        className="min-h-0 overflow-y-auto space-y-3 max-lg:overflow-visible"
      >
        {query.isLoading && (
          <p className="text-[12px] text-muted-foreground">Loading...</p>
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
      </div>

      <Composer
        className="shrink-0 mt-3"
        placeholder="Add a comment… @username to mention"
        submitLabel="Comment"
        pending={add.isPending}
        onSubmit={(body) => add.mutateAsync(body)}
      />
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
  const created = new Date(comment.created_at);

  return (
    <div className="group flex items-start gap-2">
      <UserAvatar
        username={comment.author.username}
        avatarUrl={comment.author.avatar_url}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {comment.author.username}
          </span>
          <span title={created.toLocaleString()}>
            {formatDuration(comment.created_at)} ago
          </span>
          {comment.edited_at && (
            <span title={`Edited ${new Date(comment.edited_at).toLocaleString()}`}>
              (edited)
            </span>
          )}
          {mine && !editing && (
            <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover-none:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 tap-target"
                title="Edit"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 tap-target text-destructive hover:text-destructive"
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
          <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
            <MentionText body={comment.body} />
          </p>
        )}
      </div>
    </div>
  );
}

function MentionText({ body }: { body: string }) {
  const users = useUsersQuery().data ?? [];
  const known = new Set(users.map((u) => u.username.toLowerCase()));
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const name = m[2].replace(/[.+-]+$/, "");
    if (!known.has(name.toLowerCase())) continue;
    const start = m.index + m[1].length;
    parts.push(body.slice(last, start));
    parts.push(
      <span key={start} className="font-medium text-primary">
        @{name}
      </span>,
    );
    last = start + 1 + name.length;
  }
  parts.push(body.slice(last));
  return <>{parts}</>;
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
    <div className={cn("space-y-1.5", className)}>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="min-h-[3.5rem] text-[13px] resize-none"
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
        <div className="flex justify-end gap-1.5">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Saving..." : submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
