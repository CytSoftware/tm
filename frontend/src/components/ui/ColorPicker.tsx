"use client";

import { cn } from "@/lib/utils";

/**
 * 24 preset colors that work on both light and dark backgrounds. Muted,
 * desaturated tones that match the restrained monochrome-forward palette.
 */
export const PRESET_COLORS = [
  // Row 1: warm
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  // Row 2: cool
  "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6",
  // Row 3: purple-pink
  "#a855f7", "#c084fc", "#d946ef", "#ec4899", "#f43f5e", "#fb7185",
  // Row 4: neutrals + earthy
  "#78716c", "#a8a29e", "#64748b", "#94a3b8", "#6b7280", "#9ca3af",
] as const;

type ColorPickerProps = {
  value: string;
  onChange: (color: string) => void;
  className?: string;
};

export function ColorPicker({ value, onChange, className }: ColorPickerProps) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {PRESET_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            "size-6 rounded-full transition-all",
            value === color
              ? "ring-2 ring-foreground ring-offset-2 ring-offset-background scale-110"
              : "hover:scale-110",
          )}
          style={{ background: color }}
          aria-label={color}
        />
      ))}
    </div>
  );
}
