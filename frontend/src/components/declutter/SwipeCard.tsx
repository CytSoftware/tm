"use client";

/**
 * The Tinder-style triage card rendered inside ``DeclutterDialog``.
 *
 * Owns its own pointer-drag state via ``useSwipe`` but the exit animation
 * is controlled by the parent through ``pendingDir`` — that way a swipe
 * from the user and an arrow-key / on-screen button press share the same
 * visual exit. The card emits ``onExitDone`` after the transition ends so
 * the parent can advance its cursor.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  Trash2,
} from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/UserAvatar";
import { TimeInColumn } from "@/components/task/TimeInColumn";
import { useSwipe, type SwipeDirection } from "@/hooks/use-swipe";
import { cn } from "@/lib/utils";
import { withAlpha } from "@/lib/colors";
import type { Priority, Task } from "@/lib/types";

type Props = {
  task: Task;
  /** When set, the card animates to an off-screen exit vector and then fires
   *  ``onExitDone``. Null means "resting" (pointer-drag interactive). */
  pendingDir: SwipeDirection | null;
  onCommit: (dir: SwipeDirection) => void;
  onExitDone: () => void;
  /** Hint overlay text at the top of the card (e.g. "Task no longer available"). */
  hint?: string;
};

const PRIORITY_BADGE: Record<
  Priority,
  { bg: string; text: string; border: string }
> = {
  P1: {
    bg: "bg-red-500/10",
    text: "text-red-600 dark:text-red-400",
    border: "border-red-500/30",
  },
  P2: {
    bg: "bg-orange-500/10",
    text: "text-orange-600 dark:text-orange-400",
    border: "border-orange-500/30",
  },
  P3: {
    bg: "bg-blue-500/10",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-blue-500/30",
  },
  P4: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
  },
};

export function SwipeCard({
  task,
  pendingDir,
  onCommit,
  onExitDone,
  hint,
}: Props) {
  const { bind, dx, dy, dragging } = useSwipe({
    threshold: 120,
    onCommit,
    disabled: pendingDir != null,
  });

  // Guard so onExitDone fires exactly once per commit animation.
  const exitFired = useRef(false);
  useEffect(() => {
    exitFired.current = false;
  }, [task.id, pendingDir]);

  // Fallback timer in case transitionend doesn't fire (e.g. reduced-motion).
  useEffect(() => {
    if (pendingDir == null) return;
    const id = window.setTimeout(() => {
      if (!exitFired.current) {
        exitFired.current = true;
        onExitDone();
      }
    }, 720);
    return () => window.clearTimeout(id);
  }, [pendingDir, onExitDone]);

  const committing = pendingDir != null;
  // Detect whether this commit was triggered by a drag or by a keyboard /
  // button press. Drags start with non-zero dx/dy and feel natural with
  // a punchy ease-out; discrete commits start at (0, 0) and benefit from
  // a gentler ease-in-out with a longer duration so the card doesn't just
  // pop off-screen.
  const dragCommit = committing && (Math.abs(dx) > 4 || Math.abs(dy) > 4);
  const exitDuration = dragCommit ? 420 : 560;
  const exitEasing = dragCommit
    ? "cubic-bezier(0.2, 0.7, 0.2, 1)"
    : "cubic-bezier(0.5, 0, 0.2, 1)";
  const { tx, ty, rot } = computeTransform(dx, dy, pendingDir);

  const directionalTint = tintFor(dragging ? deriveDirection(dx, dy) : pendingDir);

  const pri = task.priority ? PRIORITY_BADGE[task.priority] : null;
  const projectColor = task.project_color ?? "#6366f1";
  const projectLabel = task.project_name ?? task.project_prefix ?? "";

  const descriptionHtml =
    task.description && task.description.trim().length > 0
      ? task.description
      : "<p class='text-muted-foreground/70'>No description.</p>";

  return (
    <div
      {...bind}
      onTransitionEnd={(e) => {
        if (!committing) return;
        if (e.propertyName !== "transform") return;
        if (exitFired.current) return;
        exitFired.current = true;
        onExitDone();
      }}
      style={{
        transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg)`,
        transition: committing
          ? `transform ${exitDuration}ms ${exitEasing}, opacity ${exitDuration}ms ease-out, box-shadow 240ms`
          : !dragging
            ? "transform 220ms ease-out, opacity 220ms ease-out, box-shadow 180ms"
            : "none",
        opacity: committing ? 0 : opacityFor(dx, dy),
        touchAction: "none",
      }}
      className={cn(
        "relative h-full w-full flex flex-col min-h-0 rounded-xl border bg-card text-card-foreground",
        "select-none cursor-grab active:cursor-grabbing",
        "shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
        dragging && "shadow-[0_10px_40px_rgba(0,0,0,0.12)]",
      )}
    >
      {/* Direction tint overlay */}
      {directionalTint && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 rounded-xl transition-opacity",
            directionalTint.className,
          )}
          style={{ opacity: directionalTint.opacity }}
        />
      )}

      {hint && (
        <div className="shrink-0 px-5 py-2 text-[12px] text-center text-muted-foreground bg-muted/40 border-b border-border/60">
          {hint}
        </div>
      )}

      {/* Header: project pill + key + priority + time-in-column */}
      <div className="shrink-0 flex items-center gap-2 px-6 pt-5 pb-2">
        {projectLabel && (
          <span
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold border"
            style={{
              background: withAlpha(projectColor, 0.14),
              color: projectColor,
              borderColor: withAlpha(projectColor, 0.35),
            }}
            title={projectLabel}
          >
            <span
              className="size-1.5 rounded-full shrink-0"
              style={{ background: projectColor }}
            />
            {projectLabel}
          </span>
        )}
        <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
          {task.key}
        </span>
        {pri && (
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded border font-semibold font-mono tracking-wider",
              pri.bg,
              pri.text,
              pri.border,
            )}
          >
            {task.priority}
          </span>
        )}
        <div className="ml-auto">
          <TimeInColumn task={task} size="sm" />
        </div>
      </div>

      {/* Title */}
      <h2 className="shrink-0 px-6 pb-3 text-[22px] font-semibold tracking-tight leading-tight break-words">
        {task.title}
      </h2>

      {/* Description (scrollable) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
        <div
          className="prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: descriptionHtml }}
        />
      </div>

      {/* Meta grid */}
      <div className="shrink-0 px-6 py-3 border-t border-border/60 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
        <MetaRow label="Assignees">
          {task.assignees.length === 0 ? (
            <span className="text-muted-foreground">Unassigned</span>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="flex items-center -space-x-1.5">
                {task.assignees.slice(0, 4).map((u) => (
                  <Tooltip key={u.id}>
                    <TooltipTrigger
                      render={
                        <div className="ring-2 ring-card rounded-full">
                          <UserAvatar
                            username={u.username}
                            avatarUrl={u.avatar_url}
                            size="size-5"
                          />
                        </div>
                      }
                    />
                    <TooltipContent>{u.username}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
              {task.assignees.length > 4 && (
                <span className="text-muted-foreground text-[11px]">
                  +{task.assignees.length - 4}
                </span>
              )}
            </div>
          )}
        </MetaRow>

        <MetaRow label="Labels">
          {task.labels.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {task.labels.map((l) => (
                <span
                  key={l.id}
                  className="text-[10px] font-medium px-1.5 py-[2px] rounded-md"
                  style={{
                    background: withAlpha(l.color, 0.14),
                    color: l.color,
                  }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </MetaRow>

        <MetaRow label="Story points">
          {task.story_points != null ? (
            <span className="font-mono tabular-nums">{task.story_points}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </MetaRow>

        <MetaRow label="Due">
          {task.due_at ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3 text-muted-foreground" />
              {new Date(task.due_at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </MetaRow>
      </div>
    </div>
  );
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-[88px] shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Motion helpers
// ---------------------------------------------------------------------------

function computeTransform(
  dx: number,
  dy: number,
  pendingDir: SwipeDirection | null,
): { tx: number; ty: number; rot: number } {
  if (pendingDir != null && typeof window !== "undefined") {
    const w = window.innerWidth;
    const h = window.innerHeight;
    switch (pendingDir) {
      case "left":
        return { tx: -w * 1.3, ty: dy * 0.2, rot: -18 };
      case "right":
        return { tx: w * 1.3, ty: dy * 0.2, rot: 18 };
      case "up":
        return { tx: dx * 0.2, ty: -h * 1.1, rot: 0 };
      case "down":
        return { tx: dx * 0.2, ty: h * 1.1, rot: 0 };
    }
  }
  return { tx: dx, ty: dy, rot: dx * 0.05 };
}

function opacityFor(dx: number, dy: number): number {
  const dist = Math.hypot(dx, dy);
  return Math.max(0.45, 1 - dist / 480);
}

function deriveDirection(dx: number, dy: number): SwipeDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 30 && ay < 30) return null;
  if (ax > ay) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function tintFor(
  dir: SwipeDirection | null,
): { className: string; opacity: number } | null {
  if (dir == null) return null;
  const op = 0.15;
  switch (dir) {
    case "right":
      return { className: "bg-emerald-500/30", opacity: op };
    case "left":
      return { className: "bg-slate-500/30", opacity: op };
    case "up":
      return { className: "bg-sky-500/30", opacity: op };
    case "down":
      return { className: "bg-red-500/30", opacity: op };
  }
}

// Re-exported for the dialog's direction legend.
export const DIRECTION_META: Record<
  SwipeDirection,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  right: { label: "Todo", icon: ArrowRight },
  left: { label: "Skip", icon: ArrowLeft },
  up: { label: "Done", icon: ArrowUp },
  down: { label: "Delete", icon: ArrowDown },
};

export const DIRECTION_ACCENT: Record<SwipeDirection, string> = {
  right: "hover:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  left: "hover:bg-slate-500/15 text-muted-foreground",
  up: "hover:bg-sky-500/15 text-sky-600 dark:text-sky-400",
  down: "hover:bg-red-500/15 text-red-600 dark:text-red-400",
};

export const DIRECTION_STATUS_ICON: Record<
  SwipeDirection,
  React.ComponentType<{ className?: string }>
> = {
  right: ArrowRight,
  left: ArrowLeft,
  up: CheckCircle2,
  down: Trash2,
};
