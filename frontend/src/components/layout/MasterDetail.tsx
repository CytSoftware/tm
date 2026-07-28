"use client";

import { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";

type MasterDetailProps = {
  /** Desktop rail width, as a Tailwind class (`"w-72"`, `"w-80"`, …). */
  railWidth: string;
  /** Whether the detail pane has something to show. Drives which pane is
   *  visible on mobile; the desktop layout ignores it. */
  hasSelection: boolean;
  /** Back out of the detail pane on mobile. Usually clears the selection. */
  onBack: () => void;
  /** Label for the mobile back button, e.g. `"Wiki"`. */
  backLabel: string;
  master: ReactNode;
  detail: ReactNode;
  className?: string;
};

/**
 * Two-pane master/detail layout (TAS-061).
 *
 * Desktop is the usual fixed rail beside a flexible detail pane. On mobile the
 * two panes take turns: a `w-72` rail beside a detail pane leaves ~70px of
 * content at 360px, so instead the list fills the screen until you pick
 * something, then the detail fills the screen with a back button.
 *
 * Selection state stays with the caller — this only reads `hasSelection` and
 * calls `onBack`. Pages that put selection in the URL therefore keep working
 * with the browser's own back button unchanged.
 */
export function MasterDetail({
  railWidth,
  hasSelection,
  onBack,
  backLabel,
  master,
  detail,
  className,
}: MasterDetailProps) {
  return (
    <div className={cn("h-full flex min-h-0", className)}>
      <aside
        className={cn(
          "shrink-0 border-r border-border flex flex-col min-h-0",
          railWidth,
          // Mobile: the rail *is* the page until something is selected.
          "max-lg:w-full max-lg:border-r-0",
          hasSelection && "max-lg:hidden",
        )}
      >
        {master}
      </aside>
      <main
        className={cn(
          "flex-1 min-w-0 min-h-0 flex flex-col",
          !hasSelection && "max-lg:hidden",
        )}
      >
        {hasSelection && (
          <div className="lg:hidden shrink-0 border-b border-border">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1 px-2 py-2.5 text-[13px] text-muted-foreground active:bg-accent"
            >
              <ChevronLeft className="size-4" />
              {backLabel}
            </button>
          </div>
        )}
        {detail}
      </main>
    </div>
  );
}
