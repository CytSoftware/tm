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
