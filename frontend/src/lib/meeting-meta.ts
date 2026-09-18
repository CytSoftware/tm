/**
 * Shared presentation metadata for meetings: category labels + colors, and
 * the small formatters every view uses.
 *
 * Category colors are hues from the dataviz reference palette. The graph is a
 * scatter-like form (any two nodes can sit side by side), so the set has to
 * separate under the validator's `--pairs all` check — and no five of the
 * palette's hues do, in either mode. Four pass (blue / yellow / magenta /
 * green, verified light + dark); the two remaining, lower-volume categories
 * take neutral inks instead of a generated hue. Color is never the only
 * carrier anyway: the legend, tooltips and list rows all name the category.
 */

import type { MeetingCategory } from "@/hooks/use-meetings";

type Tone = { light: string; dark: string };

export const CATEGORY_META: Record<
  MeetingCategory,
  { label: string; color: Tone }
> = {
  client: { label: "Client", color: { light: "#2a78d6", dark: "#3987e5" } },
  internal: { label: "Internal", color: { light: "#008300", dark: "#008300" } },
  sales: { label: "Sales", color: { light: "#eda100", dark: "#c98500" } },
  pitch_feedback: {
    label: "Pitch feedback",
    color: { light: "#e87ba4", dark: "#d55181" },
  },
  interview: {
    label: "Interview",
    color: { light: "#52514e", dark: "#c3c2b7" },
  },
  other: { label: "Other", color: { light: "#898781", dark: "#898781" } },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_META) as MeetingCategory[];

export function categoryColor(
  category: MeetingCategory,
  dark: boolean,
): string {
  const tone = (CATEGORY_META[category] ?? CATEGORY_META.other).color;
  return dark ? tone.dark : tone.light;
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "AK" for "Ali K.", "A" for "Acme". */
export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => Array.from(p)[0] ?? "");
  return letters.join("").toUpperCase();
}
