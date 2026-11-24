"use client";

/**
 * The open task's activity rail: comments, column moves and PR events in one
 * timeline (oldest first), with the comment box pinned at the bottom.
 * Authors can edit or delete their own comments (the server enforces it too).
 * The project socket's `task.commented` event keeps other open panels in sync
 * (see `lib/ws.ts`).
 */

import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/UserAvatar";
import { formatDuration } from "./TimeInColumn";
import { apiFetch } from "@/lib/api";
import { taskCommentsKey } from "@/lib/query-keys";
import type { LinkedPR, StateTransition, TaskComment } from "@/lib/types";
import { cn } from "@/lib/utils";

type Entry =
  | { kind: "comment"; at: string; id: string; comment: TaskComment }
  | { kind: "event"; at: string; id: string; text: string };

export function TaskActivity({
  taskKey,
  meId,
  linkedPrs,
  composerRef,
}: {
  taskKey: string;
  meId: number | null;
  linkedPrs: LinkedPR[];
  /** Lets the panel focus the comment box from its `c` shortcut. */
  composerRef?: Ref<HTMLTextAreaElement>;
}) {
  const queryClient = useQueryClient();
  const comments = useQuery({
    queryKey: taskCommentsKey(taskKey),
    queryFn: () => apiFetch<TaskComment[]>(`/api/tasks/${taskKey}/comments/`),
  });
  const transitions = useQuery({
    queryKey: ["task-transitions", taskKey],
    queryFn: () =>
      apiFetch<StateTransition[]>(`/api/tasks/${taskKey}/transitions/`),
  });

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const c of comments.data ?? []) {
      out.push({ kind: "comment", at: c.created_at, id: `c${c.id}`, comment: c });
    }
    for (const t of transitions.data ?? []) {
      const who = transitionActor(t);
      out.push({
        kind: "event",
        at: t.at,
        id: `t${t.id}`,
        text: t.from_column
          ? `${who} moved it to ${t.to_column?.name ?? "—"}`
          : `${who} created this in ${t.to_column?.name ?? "the Inbox"}`,
      });
    }
    for (const pr of linkedPrs) {
      const n = `PR #${pr.pr_number}`;
      if (pr.opened_at) {
        out.push({ kind: "event", at: pr.opened_at, id: `po${pr.id}`, text: `${n} opened by ${pr.author_login}` });
      }
      if (pr.merged && pr.merged_at) {
        out.push({ kind: "event", at: pr.merged_at, id: `pm${pr.id}`, text: `${n} merged` });
      } else if (pr.state === "closed" && pr.closed_at) {
        out.push({ kind: "event", at: pr.closed_at, id: `pc${pr.id}`, text: `${n} closed` });
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [comments.data, transitions.data, linkedPrs]);

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

  // Keep the newest entry in view as the timeline grows.
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const loading = comments.isLoading || transitions.isLoading;

  return (
    <>
      <h3 className="shrink-0 px-4 pt-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Activity
      </h3>
      <div
        ref={feedRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 pb-2 max-lg:overflow-visible"
      >
        {loading && (
          <p className="text-[12px] text-muted-foreground">Loading...</p>
        )}
        {entries.map((e) =>
          e.kind === "event" ? (
            <p
              key={e.id}
              className="py-1 pl-[26px] text-[11.5px] text-muted-foreground"
              title={new Date(e.at).toLocaleString()}
            >
              {e.text} · {formatDuration(e.at)}
            </p>
          ) : (
            <CommentRow
              key={e.id}
              comment={e.comment}
              mine={e.comment.author.id === meId}
              onEdit={(body) => edit.mutateAsync({ id: e.comment.id, body })}
              onDelete={() => {
                if (confirm("Delete this comment?")) remove.mutate(e.comment.id);
              }}
            />
          ),
        )}
      </div>
      <div className="shrink-0 px-3.5 pt-2 pb-3.5">
        <Composer
          inputRef={composerRef}
          placeholder="Write a comment…"
          submitLabel="Comment"
          pending={add.isPending}
          onSubmit={(body) => add.mutateAsync(body)}
        />
      </div>
    </>
  );
}

function transitionActor(t: StateTransition): string {
  if (t.triggered_by) return t.triggered_by.username;
  switch (t.source) {
    case "recurring":
      return "Recurring";
    case "mcp":
      return "An agent";
    case "github":
      return "GitHub";
    default:
      return "The system";
  }
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
    <div className="group flex gap-2 py-2">
      <UserAvatar
        username={comment.author.username}
        avatarUrl={comment.author.avatar_url}
        size="size-5"
        className="mt-px"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="font-semibold text-foreground truncate">
            {comment.author.username}
          </span>
          <span
            className="shrink-0"
            title={new Date(comment.created_at).toLocaleString()}
          >
            {formatDuration(comment.created_at)}
          </span>
          {comment.edited_at && (
            <span
              className="shrink-0"
              title={`Edited ${new Date(comment.edited_at).toLocaleString()}`}
            >
              · edited
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
          <p className="mt-0.5 text-[13px] leading-snug whitespace-pre-wrap break-words">
            {comment.body}
          </p>
        )}
      </div>
    </div>
  );
}

/** Textarea + submit. ⌘/Ctrl+Enter submits and Escape cancels or blurs —
 *  both stop propagation so the panel's own shortcuts (close) don't fire. */
function Composer({
  initial = "",
  placeholder,
  submitLabel,
  pending,
  autoFocus,
  className,
  inputRef,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  pending?: boolean;
  autoFocus?: boolean;
  className?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
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
        ref={inputRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="min-h-[2.75rem] px-2.5 py-2 text-[13px] resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            void submit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            if (onCancel) onCancel();
            else e.currentTarget.blur();
          }
        }}
      />
      {(body.trim() || onCancel) && (
        <div className="flex items-center justify-end gap-1">
          <span className="mr-auto text-[10.5px] text-muted-foreground max-lg:hidden">
            ⌘↵
          </span>
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
