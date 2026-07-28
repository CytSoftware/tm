"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Edge-anchored panel, built on the same Base UI dialog as `dialog.tsx` (this
 * repo uses Base UI, not Radix — don't reach for shadcn's Radix `sheet`).
 *
 * Added for TAS-061 as the one primitive behind every mobile overlay: the
 * shell's nav drawer, the board's "move task" sheet, the mobile filter panel.
 * It exists mostly because the hand-rolled overlay it replaced had no focus
 * trap, no scroll lock and no Escape handling — all of which come free here.
 */

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

const sheetVariants = cva(
  "fixed z-50 flex flex-col bg-card text-card-foreground shadow-2xl duration-200 outline-none data-open:animate-in data-closed:animate-out",
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 h-dvh w-[min(20rem,85vw)] border-r pl-safe data-open:slide-in-from-left data-closed:slide-out-to-left",
        right:
          "inset-y-0 right-0 h-dvh w-[min(20rem,85vw)] border-l pr-safe data-open:slide-in-from-right data-closed:slide-out-to-right",
        // Bottom sheets stop short of the full height so the backdrop stays
        // tappable, and pad past the home indicator.
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border border-b-0 pb-safe data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "bottom" },
  },
);

function SheetContent({
  className,
  children,
  side,
  showHandle,
  showCloseButton = false,
  ...props
}: SheetPrimitive.Popup.Props &
  VariantProps<typeof sheetVariants> & {
    /** Grab handle. Defaults on for `side="bottom"`. */
    showHandle?: boolean;
    showCloseButton?: boolean;
  }) {
  const withHandle = showHandle ?? (side ?? "bottom") === "bottom";

  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {withHandle && (
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border"
          />
        )}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("shrink-0 flex flex-col gap-1 px-4 py-3", className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("flex-1 min-h-0 overflow-y-auto overscroll-contain", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-[15px] leading-none font-medium",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-[12px] text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
  SheetTrigger,
};
