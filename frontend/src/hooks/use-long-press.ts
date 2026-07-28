"use client";

import { useCallback, useEffect, useRef } from "react";

const HOLD_MS = 500;
/** Movement past this many px reads as a scroll, not a press. */
const SLOP_PX = 10;

type LongPressHandlers = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
};

/**
 * Touch long-press, for surfacing actions that a mouse user would reach by
 * dragging or hovering (TAS-061).
 *
 * Mouse input is deliberately ignored — a desktop user drags the card, and a
 * long mouse-down before a drag is normal. Any movement past `SLOP_PX`
 * cancels, so vertical scrolling through a column still works: we never
 * `preventDefault` the pointerdown, so the browser keeps ownership of the
 * gesture and sends us `pointercancel` when it starts scrolling.
 *
 * After firing we swallow the click that the browser synthesises on release,
 * otherwise the press would also trigger the element's normal tap action.
 */
export function useLongPress(
  onLongPress: (() => void) | undefined,
): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown: (e) => {
      if (!onLongPress || e.pointerType === "mouse") return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        // Best-effort haptic ack; absent on iOS Safari, which is fine.
        navigator.vibrate?.(10);
        onLongPress();
      }, HOLD_MS);
    },
    onPointerMove: (e) => {
      const start = origin.current;
      if (!start) return;
      if (
        Math.abs(e.clientX - start.x) > SLOP_PX ||
        Math.abs(e.clientY - start.y) > SLOP_PX
      ) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e) => {
      // Android fires a contextmenu at roughly the same hold duration; let the
      // sheet be the only thing that happens.
      if (fired.current) e.preventDefault();
    },
  };
}
