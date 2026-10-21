export type Routine = {
  id: string;
  name: string;
  prompt: string;
  skills: string[];
  script: string | null;
  schedule_display: string;
  enabled: boolean;
  state: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string;
};

export type RoutineRun = {
  session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  error: string;
};

export type TranscriptMessage = {
  role: "user" | "assistant" | "tool" | "system";
  tool_name: string | null;
  tool_calls: string[];
  content: string;
  truncated: boolean;
};

export function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

const STATUS_STYLES: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  error: "bg-destructive/10 text-destructive",
  running: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  skipped: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

export function statusStyle(status: string | null) {
  return STATUS_STYLES[status ?? ""] ?? "bg-muted text-muted-foreground";
}

export function statusLabel(status: string | null) {
  return { ok: "Succeeded", error: "Failed", running: "Running", skipped: "Nothing to do" }[status ?? ""] ?? "Unknown";
}

/** Hermes' own reason (relayed by the backend as DRF `detail`), else the HTTP summary. */
export function errorText(error: Error) {
  const detail = (error as { payload?: { detail?: unknown } }).payload?.detail;
  return typeof detail === "string" ? detail : error.message;
}

/**
 * "0 2 * * 6" → "Every Saturday at 5:00 AM" in the viewer's timezone.
 * Hermes evaluates cron in UTC. Handles the fixed-time daily/weekly shapes
 * Hermes jobs use; anything else (intervals, month days) is returned as-is.
 */
export function describeSchedule(expr: string) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [minute, hour, dom, month, dow] = fields;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dom !== "*" || month !== "*") return expr;
  const days = dow === "*" ? null : expandDays(dow);
  if (days === undefined) return expr;
  // A date near today keeps the local offset (DST) current.
  const at = (day: number | null) => {
    const date = new Date();
    date.setUTCHours(Number(hour), Number(minute), 0, 0);
    if (day !== null) date.setUTCDate(date.getUTCDate() + ((day - date.getUTCDay() + 7) % 7));
    return date;
  };
  const time = at(null).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === null || days.length === 7) return `Every day at ${time}`;
  const names = days.map(day => at(day).toLocaleDateString(undefined, { weekday: "long" }));
  return `Every ${new Intl.ListFormat(undefined, { type: "conjunction" }).format(names)} at ${time}`;
}

function expandDays(field: string): number[] | undefined {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) return undefined;
    const [start, end] = [Number(range[1]), Number(range[2] ?? range[1])];
    if (start > end || end > 7) return undefined;
    for (let day = start; day <= end; day++) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}
