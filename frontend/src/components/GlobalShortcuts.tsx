"use client";

/**
 * App-wide keyboard shortcuts mounted once inside ``TaskDialogProvider``.
 *
 * Currently:
 *   c   →  open the New task dialog (skips when an input/textarea/
 *          contenteditable element has focus, when modifier keys are held
 *          so ⌘C still copies, and when the dialog is already open).
 *
 * The board page has its own keydown listener for ↑↓←→/Enter/Esc/Space —
 * this component intentionally avoids those keys. Any new global shortcut
 * that should also work outside the board belongs here.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useTaskDialog } from "@/lib/task-dialog";

export function GlobalShortcuts() {
  const pathname = usePathname();
  const taskDialog = useTaskDialog();

  useEffect(() => {
    if (pathname === "/login") return;

    function handler(e: KeyboardEvent) {
      // Modifier-held keys belong to the browser / OS / other handlers
      // (⌘C copy, ⌘B sidebar, ⌘K search). Don't grab them.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Don't fire while typing.
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      if (taskDialog.isOpen) return;

      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        taskDialog.createTask();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pathname, taskDialog]);

  return null;
}
