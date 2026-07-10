/**
 * Chart chrome + accent colors for the analytics page.
 *
 * Values come from the dataviz skill's validated reference palette (see
 * `references/palette.md` in the `dataviz` skill), not the app's own
 * near-grayscale `--chart-1..5` theme tokens — those are unassigned
 * placeholders with no hue.
 *
 * The weekly-completions chart is nominal-categorical-by-person, but per the
 * skill's color formula (`color-formula.md`) a nominal set where reordering
 * doesn't change meaning takes a SINGLE slot-1 hue for every bar — not a
 * generated per-person palette. "Unassigned" is the one exception: it's a
 * distinct, always-last bucket, so it's treated as an emphasis "de-emphasize
 * the rest" gray rather than a second identity color.
 */

/** Slot-1 blue — the one accent hue used for every real-person completions
 *  bar, the current-week bar in the trend strip, and the totals-row figure. */
export const COMPLETIONS_ACCENT = { light: "#2a78d6", dark: "#3987e5" };

/** The "Unassigned" bucket + de-emphasized (non-selected) trend bars — the
 *  chrome's muted-ink gray (same value both modes, already validated as the
 *  app's de-emphasis step for axis/legend text), reused as a fill rather
 *  than a second identity hue. */
export const COMPLETIONS_MUTED = "#898781";

export type ChartChrome = {
  surface: string;
  primaryInk: string;
  secondaryInk: string;
  mutedInk: string;
  gridline: string;
  baseline: string;
};

/** Chart chrome (surface-relative ink/gridlines), from the same reference
 *  palette so the chart's neutrals stay consistent with its own validated
 *  contrast numbers rather than the app's oklch tokens. */
export const CHART_CHROME: Record<"light" | "dark", ChartChrome> = {
  light: {
    surface: "#fcfcfb",
    primaryInk: "#0b0b0b",
    secondaryInk: "#52514e",
    mutedInk: "#898781",
    gridline: "#e1e0d9",
    baseline: "#c3c2b7",
  },
  dark: {
    surface: "#1a1a19",
    primaryInk: "#ffffff",
    secondaryInk: "#c3c2b7",
    mutedInk: "#898781",
    gridline: "#2c2c2a",
    baseline: "#383835",
  },
};
