/**
 * Cyt OS period grid — client mirror of `backend/apps/tasks/periods.py`.
 *
 * Bets belong to fixed two-month periods anchored at **July 1, 2026**:
 *
 *     period n = [anchor + 2n months, anchor + 2(n+1) months)
 *
 * Periods are pure math — nothing is stored or generated. All functions
 * work on ISO date strings (`"2026-07-01"`) to avoid timezone drift from
 * `Date` round-trips.
 */

export const PERIOD_ANCHOR = "2026-07-01";
export const PERIOD_MONTHS = 2;

/** Months since year 0 — turns month arithmetic into integer math. */
function monthIndex(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return y * 12 + (m - 1);
}

function fromMonthIndex(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Snap any ISO date to the first day of the period containing it. */
export function periodStartFor(iso: string): string {
  const offset = monthIndex(iso) - monthIndex(PERIOD_ANCHOR);
  const startOffset = Math.floor(offset / PERIOD_MONTHS) * PERIOD_MONTHS;
  return fromMonthIndex(monthIndex(PERIOD_ANCHOR) + startOffset);
}

export function currentPeriodStart(now: Date = new Date()): string {
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return periodStartFor(iso);
}

/** The period immediately after/before the one starting at `start`. */
export function shiftPeriod(start: string, by: number): string {
  return fromMonthIndex(monthIndex(start) + by * PERIOD_MONTHS);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Human label like `"Jul–Aug 2026"` (`"Dec 2026–Jan 2027"` across years). */
export function periodLabel(start: string): string {
  const first = monthIndex(start);
  const last = first + PERIOD_MONTHS - 1;
  const fy = Math.floor(first / 12);
  const ly = Math.floor(last / 12);
  if (fy === ly) return `${MONTHS[first % 12]}–${MONTHS[last % 12]} ${fy}`;
  return `${MONTHS[first % 12]} ${fy}–${MONTHS[last % 12]} ${ly}`;
}
