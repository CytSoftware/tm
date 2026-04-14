"use client";

/**
 * Pointer-event swipe hook.
 *
 * Tracks drag deltas from pointer-down and fires ``onCommit(dir)`` when the
 * cursor crosses ``threshold`` px on the dominant axis. Returns the live
 * deltas so the consumer can drive a CSS transform for visual feedback.
 *
 * Pointer events cover mouse + touch + pen uniformly. We set pointer capture
 * so the drag survives if the pointer leaves the card's bounding box mid-drag
 * (common when the card starts animating off-screen).
 */

import { useRef, useState, type PointerEvent } from "react";

export type SwipeDirection = "left" | "right" | "up" | "down";

type UseSwipeArgs = {
  /** Pixels the pointer must travel on the dominant axis to commit. */
  threshold?: number;
  /** Fired once when a commit direction is detected on pointer release. */
  onCommit: (dir: SwipeDirection) => void;
  /** Disable gesture tracking (e.g. during exit animation). */
  disabled?: boolean;
};

type Bind = {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
};

export function useSwipe({
  threshold = 120,
  onCommit,
  disabled,
}: UseSwipeArgs): { bind: Bind; dx: number; dy: number; dragging: boolean } {
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(
    null,
  );

  function reset() {
    setDx(0);
    setDy(0);
    setDragging(false);
    start.current = null;
  }

  const bind: Bind = {
    onPointerDown: (e) => {
      if (disabled) return;
      // Only primary button for mouse; touch / pen always qualify.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      setDragging(true);
    },
    onPointerMove: (e) => {
      if (disabled || !start.current) return;
      if (e.pointerId !== start.current.pointerId) return;
      setDx(e.clientX - start.current.x);
      setDy(e.clientY - start.current.y);
    },
    onPointerUp: (e) => {
      if (!start.current) return;
      if (e.pointerId !== start.current.pointerId) return;
      const dir = pickDirection(dx, dy, threshold);
      if (dir) {
        onCommit(dir);
      }
      reset();
    },
    onPointerCancel: () => {
      reset();
    },
  };

  return { bind, dx, dy, dragging };
}

/** Return the commit direction or null. Dominant axis wins with a small bias
 *  so near-diagonal drags don't flicker between horizontal and vertical. */
export function pickDirection(
  dx: number,
  dy: number,
  threshold: number,
): SwipeDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // Horizontal takes priority when it's meaningfully dominant.
  if (ax >= threshold && ax >= ay + 10) return dx > 0 ? "right" : "left";
  if (ay >= threshold && ay >= ax + 10) return dy > 0 ? "down" : "up";
  return null;
}
