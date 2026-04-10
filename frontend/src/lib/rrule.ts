/**
 * Thin wrappers around the `rrule` npm package.
 *
 * Keeps human-readable rendering and preset translation in one place so the
 * rest of the app doesn't import `rrule` directly.
 */

import { RRule, rrulestr } from "rrule";

/** Render an RRULE as a human-readable phrase (e.g. "every weekday"). */
export function humanizeRrule(rrule: string): string {
  try {
    const rule = rrulestr(rrule);
    return rule.toText();
  } catch {
    return rrule;
  }
}

/** Return the next N occurrences from an RRULE starting at dtstart. */
export function previewOccurrences(
  rrule: string,
  dtstart: Date,
  count = 3,
): Date[] {
  try {
    const rule = rrulestr(rrule, { dtstart });
    const now = new Date();
    // rrule's `after` walks forward; collect up to `count` occurrences.
    const out: Date[] = [];
    let cursor: Date | null = rule.after(now, true);
    while (cursor && out.length < count) {
      out.push(cursor);
      cursor = rule.after(cursor, false);
    }
    return out;
  } catch {
    return [];
  }
}

export type SchedulePreset =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

/** Translate a preset + optional config into an RRULE string. */
export function presetToRrule(
  preset: SchedulePreset,
  options?: {
    weekdays?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
    monthDay?: number;
    customRrule?: string;
  },
): string | null {
  switch (preset) {
    case "none":
      return null;
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly": {
      const days = options?.weekdays?.join(",") ?? "";
      return days ? `FREQ=WEEKLY;BYDAY=${days}` : "FREQ=WEEKLY";
    }
    case "monthly": {
      const d = options?.monthDay;
      return d ? `FREQ=MONTHLY;BYMONTHDAY=${d}` : "FREQ=MONTHLY";
    }
    case "custom":
      return options?.customRrule?.trim() || null;
  }
}

/** Guess a preset from an existing RRULE for UI round-tripping. */
export function rruleToPreset(rrule: string | null): SchedulePreset {
  if (!rrule) return "none";
  const normalized = rrule.toUpperCase().replace(/\s+/g, "");
  if (normalized === "FREQ=DAILY") return "daily";
  if (normalized === "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") return "weekdays";
  if (normalized.startsWith("FREQ=WEEKLY")) return "weekly";
  if (normalized.startsWith("FREQ=MONTHLY")) return "monthly";
  return "custom";
}

export { RRule };
