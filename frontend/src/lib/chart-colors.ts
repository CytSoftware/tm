/**
 * Chart chrome + categorical palette for the analytics page.
 *
 * Values come from the dataviz skill's validated reference palette (see
 * `references/palette.md` in the `dataviz` skill), not the app's own
 * near-grayscale `--chart-1..5` theme tokens — those are unassigned
 * placeholders with no hue, unsuitable for telling four series apart.
 * Both light and dark steps here were run through the skill's
 * `validate_palette.js` (lightness band, chroma floor, CVD separation,
 * contrast) before being picked.
 *
 * Slot order is fixed (never cycled) and follows the task pipeline:
 * created → started → in_review → completed.
 */

import type { ThroughputMetric } from "./types";

export const THROUGHPUT_COLORS: Record<
  ThroughputMetric,
  { light: string; dark: string }
> = {
  created: { light: "#2a78d6", dark: "#3987e5" }, // categorical slot 1 — blue
  started: { light: "#1baf7a", dark: "#199e70" }, // categorical slot 2 — aqua
  in_review: { light: "#eda100", dark: "#c98500" }, // categorical slot 3 — yellow
  completed: { light: "#008300", dark: "#008300" }, // categorical slot 4 — green
};

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
