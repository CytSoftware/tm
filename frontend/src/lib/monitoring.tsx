import {
  Activity,
  Bell,
  Bug,
  Globe,
  HeartPulse,
  Radar,
  Server,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import type {
  EventPageIcon,
  EventProvider,
  EventWorkflowStatus,
  MonitoringColumn,
} from "@/lib/types";

export const PROVIDER_LABELS: Record<EventProvider, string> = {
  generic: "Generic JSON",
  sentry: "Sentry",
  uptime_kuma: "Uptime Kuma",
};

export const WORKFLOW_LABELS: Record<EventWorkflowStatus, string> = {
  new: "New",
  in_progress: "In progress",
  fixed: "Fixed",
  ignored: "Ignored",
};

export const WORKFLOW_STYLES: Record<EventWorkflowStatus, string> = {
  new: "text-blue-700 bg-blue-500/10 dark:text-blue-300",
  in_progress: "text-amber-700 bg-amber-500/10 dark:text-amber-300",
  fixed: "text-green-700 bg-green-500/10 dark:text-green-300",
  ignored: "text-muted-foreground bg-muted",
};

const ICONS: Record<EventPageIcon, LucideIcon> = {
  activity: Activity,
  bug: Bug,
  globe: Globe,
  server: Server,
  shield: ShieldAlert,
  bell: Bell,
  heart: HeartPulse,
  radar: Radar,
};

export const MONITORING_ICON_OPTIONS = Object.keys(ICONS) as EventPageIcon[];

export function MonitoringIcon({
  name,
  className,
}: {
  name: EventPageIcon;
  className?: string;
}) {
  const Icon = ICONS[name] ?? Activity;
  return <Icon className={className} />;
}

export const SYSTEM_COLUMNS: MonitoringColumn[] = [
  { id: "workflow_status", label: "Status", visible: true },
  { id: "title", label: "Event", visible: true },
  { id: "severity", label: "Severity", visible: true },
  { id: "provider_status", label: "Provider status", visible: true },
  { id: "event_type", label: "Event type", visible: false },
  { id: "occurrence_count", label: "Count", visible: true },
  { id: "last_received_at", label: "Last received", visible: true },
  { id: "occurred_at", label: "Occurred", visible: false },
  { id: "external_id", label: "External ID", visible: false },
];

export function payloadLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  return leaf.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function collectPayloadPaths(
  value: unknown,
  prefix = "",
  depth = 0,
  result = new Set<string>(),
): Set<string> {
  if (!prefix && (value === null || typeof value !== "object")) return result;
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    depth >= 4
  ) {
    if (prefix) result.add(prefix);
    return result;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectPayloadPaths(
      child,
      prefix ? `${prefix}.${key}` : key,
      depth + 1,
      result,
    );
  }
  return result;
}

export function effectiveColumns(
  saved: MonitoringColumn[],
  discoveredPaths: string[],
): MonitoringColumn[] {
  const base = saved.length > 0 ? saved : SYSTEM_COLUMNS;
  const ids = new Set(base.map((column) => column.id));
  const missingSystem = SYSTEM_COLUMNS.filter((column) => !ids.has(column.id));
  const missingPayload = discoveredPaths
    .map((path) => ({
      id: `payload:${path}`,
      label: payloadLabel(path),
      visible: false,
    }))
    .filter((column) => !ids.has(column.id));
  return [...base, ...missingSystem, ...missingPayload];
}

export function valueAtPath(
  payload: Record<string, unknown>,
  path: string,
): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function formatEventDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
