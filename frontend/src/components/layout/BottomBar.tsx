"use client";

/**
 * Mobile bottom navigation bar — the primary nav surface on phones, replacing
 * the sidebar (hidden below `lg`). A normal-flow flex sibling of <main> in
 * Shell, NOT position:fixed — the shell's `h-dvh flex flex-col overflow-hidden`
 * invariant means every visible pixel of chrome has to claim its own flex
 * row, or `pb-safe` here would pad space that's already scrolled offscreen.
 *
 * Five slots: Home, Tasks, a raised center Quick Add, Search, Menu. Home and
 * Tasks are real navigation (usePathname/useRouter); Search/Menu/Quick Add
 * are callbacks so Shell owns the palette/sheet/task-dialog state.
 */

import { Home, LayoutDashboard, Menu, Plus, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

type BottomBarProps = {
  onQuickAdd: () => void;
  onSearch: () => void;
  onMenu: () => void;
};

export function BottomBar({ onQuickAdd, onSearch, onMenu }: BottomBarProps) {
  const router = useRouter();
  const pathname = usePathname();

  const homeActive = pathname === "/";
  const tasksActive = pathname.startsWith("/board");

  return (
    <nav
      className="lg:hidden shrink-0 pb-safe border-t border-border/80 bg-background"
      aria-label="Primary"
    >
      <div className="grid grid-cols-5 items-center px-1">
        <NavSlot
          icon={<Home className="size-5" />}
          label="Home"
          active={homeActive}
          onClick={() => router.push("/")}
        />
        <NavSlot
          icon={<LayoutDashboard className="size-5" />}
          label="Tasks"
          active={tasksActive}
          onClick={() => router.push("/board")}
        />
        <div className="flex items-center justify-center py-1.5">
          <button
            type="button"
            onClick={onQuickAdd}
            aria-label="New task"
            className="tap-target size-11 rounded-full bg-foreground text-background grid place-items-center shadow-sm active:translate-y-px transition-transform"
          >
            <Plus className="size-5" />
          </button>
        </div>
        <NavSlot
          icon={<Search className="size-5" />}
          label="Search"
          onClick={onSearch}
        />
        <NavSlot icon={<Menu className="size-5" />} label="Menu" onClick={onMenu} />
      </div>
    </nav>
  );
}

function NavSlot({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** Omitted for slots that open an overlay rather than a route. */
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "tap-target flex flex-col items-center justify-center gap-0.5 py-1.5 text-muted-foreground transition-colors",
        active && "text-foreground",
      )}
    >
      {icon}
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  );
}
