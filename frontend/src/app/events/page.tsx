"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  Columns3,
  Copy,
  ExternalLink,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useCreateEventSource,
  useDeleteEventSource,
  useEventsQuery,
  useEventSourcesQuery,
  useEventSummaryQuery,
  useUpdateEvent,
  useUpdateEventSource,
} from "@/hooks/use-events";
import { cn } from "@/lib/utils";
import type {
  EventProvider,
  EventSource,
  EventWorkflowStatus,
  ExternalEvent,
} from "@/lib/types";

const PROVIDER_LABELS: Record<EventProvider, string> = {
  generic: "Generic JSON",
  sentry: "Sentry",
  uptime_kuma: "Uptime Kuma",
};

const WORKFLOW_LABELS: Record<EventWorkflowStatus, string> = {
  new: "New",
  in_progress: "In progress",
  fixed: "Fixed",
  ignored: "Ignored",
};

const WORKFLOW_STYLES: Record<EventWorkflowStatus, string> = {
  new: "text-blue-700 bg-blue-500/10 dark:text-blue-300",
  in_progress: "text-amber-700 bg-amber-500/10 dark:text-amber-300",
  fixed: "text-green-700 bg-green-500/10 dark:text-green-300",
  ignored: "text-muted-foreground bg-muted",
};

type ColumnConfig = {
  id: string;
  label: string;
  visible: boolean;
};

const SYSTEM_COLUMNS: ColumnConfig[] = [
  { id: "workflow_status", label: "Status", visible: true },
  { id: "title", label: "Event", visible: true },
  { id: "source", label: "Source", visible: true },
  { id: "provider", label: "Provider", visible: false },
  { id: "severity", label: "Severity", visible: true },
  { id: "provider_status", label: "Provider status", visible: true },
  { id: "event_type", label: "Event type", visible: false },
  { id: "occurrence_count", label: "Count", visible: true },
  { id: "last_received_at", label: "Last received", visible: true },
  { id: "occurred_at", label: "Occurred", visible: false },
  { id: "external_id", label: "External ID", visible: false },
];

const COLUMN_STORAGE_KEY = "cyt:event-inbox-columns:v1";

function payloadLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  return leaf.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function collectPayloadPaths(
  value: unknown,
  prefix = "",
  depth = 0,
  result = new Set<string>(),
): Set<string> {
  if (!prefix && (value === null || typeof value !== "object")) return result;
  if (value === null || Array.isArray(value) || typeof value !== "object" || depth >= 4) {
    if (prefix) result.add(prefix);
    return result;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectPayloadPaths(child, prefix ? `${prefix}.${key}` : key, depth + 1, result);
  }
  return result;
}

function valueAtPath(payload: Record<string, unknown>, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function EventsPage() {
  const sourcesQuery = useEventSourcesQuery();
  const sources = useMemo(() => sourcesQuery.data?.results ?? [], [sourcesQuery.data]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ExternalEvent | null>(null);
  const [columns, setColumns] = useState<ColumnConfig[]>(SYSTEM_COLUMNS);
  const [columnPreferencesLoaded, setColumnPreferencesLoaded] = useState(false);

  const selectedSource =
    sourceFilter !== "all" && sources.some((source) => String(source.id) === sourceFilter)
      ? Number(sourceFilter)
      : undefined;
  const selectedStatus =
    statusFilter === "all" ? undefined : (statusFilter as EventWorkflowStatus);
  const eventsQuery = useEventsQuery({
    source: selectedSource,
    workflow_status: selectedStatus,
    search: search.trim() || undefined,
  });
  const summaryQuery = useEventSummaryQuery(selectedSource);
  const events = useMemo(() => eventsQuery.data?.results ?? [], [eventsQuery.data]);

  const discoveredPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const event of events) collectPayloadPaths(event.payload, "", 0, paths);
    return [...paths].sort((a, b) => a.localeCompare(b));
  }, [events]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLUMN_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ColumnConfig[];
        // This effect intentionally hydrates a browser-only preference after
        // mount; reading localStorage during SSR would cause a mismatch.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (Array.isArray(parsed) && parsed.length > 0) setColumns(parsed);
      }
    } catch {
      // A malformed local preference should never prevent the inbox loading.
    }
    setColumnPreferencesLoaded(true);
  }, []);

  const effectiveColumns = useMemo(() => {
    const ids = new Set(columns.map((column) => column.id));
    const missingSystem = SYSTEM_COLUMNS.filter((column) => !ids.has(column.id));
    const missingPayload = discoveredPaths
      .map((path) => ({ id: `payload:${path}`, label: payloadLabel(path), visible: false }))
      .filter((column) => !ids.has(column.id));
    return [...columns, ...missingSystem, ...missingPayload];
  }, [columns, discoveredPaths]);

  useEffect(() => {
    if (!columnPreferencesLoaded) return;
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
  }, [columnPreferencesLoaded, columns]);

  const validSourceFilter =
    sourceFilter === "all" || sources.some((source) => String(source.id) === sourceFilter)
      ? sourceFilter
      : "all";
  const visibleColumns = effectiveColumns.filter((column) => column.visible);
  const summary = summaryQuery.data;
  const sourceItems = {
    all: "All sources",
    ...Object.fromEntries(sources.map((source) => [String(source.id), source.name])),
  };
  const statusItems = { all: "All statuses", ...WORKFLOW_LABELS };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 border-b border-border/80 px-4 py-3 space-y-3">
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-lg bg-muted grid place-items-center">
            <Activity className="size-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-semibold tracking-tight">Events</h1>
            <p className="text-[12px] text-muted-foreground">
              Webhook-driven issues and monitor alerts.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setColumnsOpen(true)}>
            <Columns3 className="size-3.5" /> Columns
          </Button>
          <Button size="sm" onClick={() => setSourcesOpen(true)}>
            <Settings2 className="size-3.5" /> Sources
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <SummaryChip label="Total" count={summary?.total ?? 0} active={statusFilter === "all"} onClick={() => setStatusFilter("all")} />
          {(Object.keys(WORKFLOW_LABELS) as EventWorkflowStatus[]).map((status) => (
            <SummaryChip
              key={status}
              label={WORKFLOW_LABELS[status]}
              count={summary?.[status] ?? 0}
              active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 max-w-sm flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search events…"
              className="pl-8 h-8 text-[12px]"
            />
          </div>
          <Select value={validSourceFilter} onValueChange={(value) => value && setSourceFilter(value)} items={sourceItems}>
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.id} value={String(source.id)}>{source.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => value && setStatusFilter(value)} items={statusItems}>
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(WORKFLOW_LABELS) as EventWorkflowStatus[]).map((status) => (
                <SelectItem key={status} value={status}>{WORKFLOW_LABELS[status]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {eventsQuery.isLoading || sourcesQuery.isLoading ? (
          <div className="h-full grid place-items-center text-[13px] text-muted-foreground">Loading events…</div>
        ) : eventsQuery.isError || sourcesQuery.isError ? (
          <div className="h-full grid place-items-center text-[13px] text-destructive">Couldn&apos;t load events.</div>
        ) : sources.length === 0 ? (
          <EmptyState
            title="Connect your first event source"
            description="Create a webhook URL for Sentry, Uptime Kuma, or any service that sends JSON."
            action="Create source"
            onAction={() => setSourcesOpen(true)}
          />
        ) : events.length === 0 ? (
          <EmptyState
            title="No matching events"
            description="Send a webhook to one of your source URLs, or clear the current filters."
            action="View sources"
            onAction={() => setSourcesOpen(true)}
          />
        ) : (
          <table className="w-full min-w-max text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
              <tr>
                {visibleColumns.map((column) => (
                  <th key={column.id} className="h-9 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  columns={visibleColumns}
                  onOpen={() => setSelectedEvent(event)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {sourcesOpen && <SourcesDialog sources={sources} onClose={() => setSourcesOpen(false)} />}
      {columnsOpen && (
        <ColumnsDialog
          columns={effectiveColumns}
          onChange={setColumns}
          onClose={() => setColumnsOpen(false)}
        />
      )}
      {selectedEvent && (
        <EventDetails event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}

function SummaryChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-6 px-2 rounded-md border text-[11px] transition-colors",
        active ? "border-foreground/25 bg-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label} <span className="ml-1 tabular-nums font-medium">{count}</span>
    </button>
  );
}

function EmptyState({ title, description, action, onAction }: { title: string; description: string; action: string; onAction: () => void }) {
  return (
    <div className="h-full grid place-items-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        <div className="mx-auto size-9 rounded-full bg-muted grid place-items-center"><Activity className="size-4 text-muted-foreground" /></div>
        <div>
          <p className="text-[14px] font-medium">{title}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>
        </div>
        <Button size="sm" onClick={onAction}>{action}</Button>
      </div>
    </div>
  );
}

function EventRow({ event, columns, onOpen }: { event: ExternalEvent; columns: ColumnConfig[]; onOpen: () => void }) {
  return (
    <tr onClick={onOpen} className="border-b border-border/60 hover:bg-muted/35 cursor-pointer transition-colors">
      {columns.map((column) => (
        <td key={column.id} className={cn("h-11 px-3 text-[12px] max-w-80", column.id === "title" && "min-w-64")}>
          <EventCell event={event} column={column} />
        </td>
      ))}
    </tr>
  );
}

function EventCell({ event, column }: { event: ExternalEvent; column: ColumnConfig }) {
  if (column.id === "workflow_status") {
    return <div onClick={(e) => e.stopPropagation()}><WorkflowSelect event={event} /></div>;
  }
  if (column.id === "title") {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-medium truncate">{event.title}</span>
        {event.target_url && <ExternalLink className="size-3 text-muted-foreground shrink-0" />}
      </div>
    );
  }
  if (column.id === "source") return <span className="whitespace-nowrap">{event.source_name}</span>;
  if (column.id === "provider") return <span>{PROVIDER_LABELS[event.provider]}</span>;
  if (column.id === "severity") {
    return event.severity ? <Badge variant="outline" className="font-normal capitalize">{event.severity}</Badge> : <span className="text-muted-foreground">—</span>;
  }
  if (column.id === "provider_status") return <span className="capitalize">{event.provider_status || "—"}</span>;
  if (column.id === "event_type") return <span className="font-mono text-[11px]">{event.event_type || "—"}</span>;
  if (column.id === "occurrence_count") return <span className="tabular-nums">{event.occurrence_count}</span>;
  if (column.id === "last_received_at") return <span className="whitespace-nowrap text-muted-foreground">{formatDate(event.last_received_at)}</span>;
  if (column.id === "occurred_at") return <span className="whitespace-nowrap text-muted-foreground">{formatDate(event.occurred_at)}</span>;
  if (column.id === "external_id") return <span className="font-mono text-[11px] text-muted-foreground">{event.external_id}</span>;
  if (column.id.startsWith("payload:")) {
    const value = displayValue(valueAtPath(event.payload, column.id.slice(8)));
    return <span className="block truncate font-mono text-[11px] text-muted-foreground" title={value}>{value}</span>;
  }
  return <span>—</span>;
}

function WorkflowSelect({ event }: { event: ExternalEvent }) {
  const update = useUpdateEvent();
  return (
    <Select
      value={event.workflow_status}
      onValueChange={(value) => value && update.mutate({ id: event.id, workflow_status: value as EventWorkflowStatus })}
      items={WORKFLOW_LABELS}
      disabled={update.isPending}
    >
      <SelectTrigger size="sm" className={cn("border-0 h-6 px-2 shadow-none text-[11px]", WORKFLOW_STYLES[event.workflow_status])}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(WORKFLOW_LABELS) as EventWorkflowStatus[]).map((status) => (
          <SelectItem key={status} value={status}>{WORKFLOW_LABELS[status]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ColumnsDialog({ columns, onChange, onClose }: { columns: ColumnConfig[]; onChange: (columns: ColumnConfig[]) => void; onClose: () => void }) {
  const visibleCount = columns.filter((column) => column.visible).length;

  function toggle(index: number) {
    onChange(columns.map((column, i) => i === index ? { ...column, visible: !column.visible } : column));
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function reset() {
    const payloadColumns = columns.filter((column) => column.id.startsWith("payload:")).map((column) => ({ ...column, visible: false }));
    onChange([...SYSTEM_COLUMNS, ...payloadColumns]);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[520px] p-0 gap-0" showCloseButton={false}>
        <div className="px-5 py-4 border-b border-border/60 flex items-center gap-3">
          <div className="flex-1">
            <DialogTitle className="text-[15px]">Table columns</DialogTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">Payload fields appear automatically after Cyt receives them.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={reset}>Reset</Button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border/50">
          {columns.map((column, index) => (
            <div key={column.id} className="flex items-center gap-2 px-5 py-2">
              <Checkbox
                checked={column.visible}
                disabled={column.visible && visibleCount === 1}
                onCheckedChange={() => toggle(index)}
              />
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => toggle(index)}>
                <span className="block text-[12px] truncate">{column.label}</span>
                {column.id.startsWith("payload:") && <span className="block text-[10px] font-mono text-muted-foreground truncate">{column.id.slice(8)}</span>}
              </button>
              <Button variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up"><ArrowUp /></Button>
              <Button variant="ghost" size="icon-xs" disabled={index === columns.length - 1} onClick={() => move(index, 1)} aria-label="Move down"><ArrowDown /></Button>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-border/60 flex justify-end">
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourcesDialog({ sources, onClose }: { sources: EventSource[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<EventProvider>("generic");
  const create = useCreateEventSource();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), provider }, { onSuccess: () => setName("") });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[640px] p-0 gap-0" showCloseButton={false}>
        <div className="px-5 py-4 border-b border-border/60">
          <DialogTitle className="text-[15px]">Event sources</DialogTitle>
          <p className="mt-1 text-[11px] text-muted-foreground">Each source has a private URL. Paste it into the provider&apos;s webhook settings.</p>
        </div>
        <form onSubmit={submit} className="px-5 py-4 border-b border-border/60 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-44 space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Name</Label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Production Sentry" className="h-8 text-[12px]" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Provider</Label>
            <Select value={provider} onValueChange={(value) => value && setProvider(value as EventProvider)} items={PROVIDER_LABELS}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(PROVIDER_LABELS) as EventProvider[]).map((item) => <SelectItem key={item} value={item}>{PROVIDER_LABELS[item]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={!name.trim() || create.isPending}><Plus /> Add source</Button>
        </form>
        <div className="max-h-[52vh] overflow-y-auto divide-y divide-border/60">
          {sources.length === 0 ? (
            <p className="px-5 py-8 text-center text-[12px] text-muted-foreground">No sources yet.</p>
          ) : sources.map((source) => <SourceRow key={source.id} source={source} />)}
        </div>
        <div className="px-5 py-3 border-t border-border/60 flex justify-end"><Button size="sm" onClick={onClose}>Done</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function SourceRow({ source }: { source: EventSource }) {
  const update = useUpdateEventSource(source.id);
  const remove = useDeleteEventSource();
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    await navigator.clipboard.writeText(source.webhook_url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function deleteSource() {
    if (confirm(`Delete "${source.name}" and all events received through it?`)) remove.mutate(source.id);
  }

  return (
    <div className="px-5 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium truncate">{source.name}</p>
          <p className="text-[11px] text-muted-foreground">{PROVIDER_LABELS[source.provider]}</p>
        </div>
        <Switch size="sm" checked={source.active} disabled={update.isPending} onCheckedChange={(active) => update.mutate({ active })} aria-label={`${source.name} active`} />
        <Button variant="ghost" size="icon-sm" onClick={deleteSource} disabled={remove.isPending} aria-label={`Delete ${source.name}`}><Trash2 className="text-destructive" /></Button>
      </div>
      <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5">
        <code className="flex-1 min-w-0 truncate text-[10px] text-muted-foreground">{source.webhook_url}</code>
        <Button variant="ghost" size="xs" onClick={copyUrl}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
      </div>
    </div>
  );
}

function EventDetails({ event, onClose }: { event: ExternalEvent; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[760px] max-h-[85vh] p-0 gap-0 flex flex-col" showCloseButton={false}>
        <div className="shrink-0 px-5 py-4 border-b border-border/60">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-[15px] leading-snug">{event.title}</DialogTitle>
              <p className="mt-1 text-[11px] text-muted-foreground">{event.source_name} · {PROVIDER_LABELS[event.provider]} · received {formatDate(event.last_received_at)}</p>
            </div>
            {event.target_url && (
              <Button variant="outline" size="sm" render={<a href={event.target_url} target="_blank" rel="noreferrer" />}>
                Open provider <ExternalLink />
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap gap-4 text-[12px]">
            <Detail label="Cyt status"><WorkflowSelect event={event} /></Detail>
            <Detail label="Provider status"><span className="capitalize">{event.provider_status || "—"}</span></Detail>
            <Detail label="Severity"><span className="capitalize">{event.severity || "—"}</span></Detail>
            <Detail label="Occurrences"><span>{event.occurrence_count}</span></Detail>
            <Detail label="External ID"><code className="text-[11px]">{event.external_id}</code></Detail>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Raw payload</p>
            <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words">{JSON.stringify(event.payload, null, 2)}</pre>
          </div>
        </div>
        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex justify-end"><Button size="sm" onClick={onClose}>Close</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>{children}</div>;
}
