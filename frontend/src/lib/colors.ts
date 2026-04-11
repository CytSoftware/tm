/**
 * Shared color palette for projects.
 *
 * Kept in sync with the backfill list in
 * `backend/apps/tasks/migrations/0007_multiassignee_priority_color_projectless.py`
 * so a freshly-migrated project picks the same default color that the
 * create-project dialog would have picked for it.
 */

export const PROJECT_COLOR_PALETTE = [
  "#6366f1", // indigo
  "#ec4899", // pink
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#84cc16", // lime
] as const;

export type ProjectPaletteColor = (typeof PROJECT_COLOR_PALETTE)[number];

/** Deterministic color for a project id. Matches the migration backfill. */
export function defaultProjectColor(seed: number): string {
  const len = PROJECT_COLOR_PALETTE.length;
  const idx = ((seed % len) + len) % len;
  return PROJECT_COLOR_PALETTE[idx];
}

/** Alpha-adjusted hex helpers used by colored pill badges. */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const a = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
  // Strip an existing alpha suffix so repeated calls don't compound.
  const base = hex.length >= 9 ? hex.slice(0, 7) : hex;
  return `${base}${a}`;
}
