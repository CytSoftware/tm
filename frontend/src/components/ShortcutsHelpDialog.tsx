"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Keep in sync with the keydown handlers: Shell (⌘B/⌘K), GlobalShortcuts (c),
// the board page, and TaskPanel/TaskDialog.
const SHORTCUT_GROUPS: {
  title: string;
  rows: { keys: string[]; description: string }[];
}[] = [
  {
    title: "Anywhere",
    rows: [
      { keys: ["⌘K"], description: "Command palette & search" },
      { keys: ["⌘B"], description: "Toggle sidebar" },
      { keys: ["c"], description: "New task" },
    ],
  },
  {
    title: "Board",
    rows: [
      { keys: ["↑", "↓", "←", "→"], description: "Move selection" },
      { keys: ["Enter"], description: "Open selected task" },
      { keys: ["Esc"], description: "Deselect / close palette" },
      { keys: ["⌘/Alt", "←", "→"], description: "Move task to prev/next column" },
      { keys: ["⌘/Alt", "↑", "↓"], description: "Reorder task in column" },
      { keys: ["1", "–", "4"], description: "Set priority P1–P4" },
      { keys: ["0"], description: "Clear priority" },
      { keys: ["d"], description: "Move to Done" },
      { keys: ["p"], description: "Edit priority" },
      { keys: ["a"], description: "Edit assignees" },
      { keys: ["l"], description: "Edit labels" },
      { keys: ["?"], description: "Show this help" },
    ],
  },
  {
    title: "Selected or open task",
    rows: [
      { keys: ["⌘C"], description: "Copy task ID" },
      { keys: ["⌘⇧C"], description: "Copy prompt for Claude" },
      { keys: ["⌘Enter"], description: "Save task" },
    ],
  },
];

/** Keyboard-shortcut cheat sheet — opened by `?` on the board and by the
 *  sidebar's help button. */
export function ShortcutsHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                {group.title}
              </div>
              {group.rows.map((row) => (
                <div
                  key={row.description}
                  className="flex items-center justify-between gap-3 text-[12px]"
                >
                  <span className="text-muted-foreground">{row.description}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {row.keys.map((k, i) => (
                      <kbd
                        key={i}
                        className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded border border-border/60 bg-muted text-[10px] font-mono text-foreground"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
