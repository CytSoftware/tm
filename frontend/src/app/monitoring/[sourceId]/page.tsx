"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search, Settings2 } from "lucide-react";
import { useParams } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useEventsQuery,
  useEventSourcesQuery,
  useEventSummaryQuery,
  useUpdateEvent,
} from "@/hooks/use-events";
import {
  collectPayloadPaths,
  displayValue,
  effectiveColumns,
  formatEventDate,
  MonitoringIcon,
  PROVIDER_LABELS,
  valueAtPath,
  WORKFLOW_LABELS,
  WORKFLOW_STYLES,
} from "@/lib/monitoring";
import { cn } from "@/lib/utils";
import type {
  EventWorkflowStatus,
  ExternalEvent,
  MonitoringColumn,
} from "@/lib/types";

export default function MonitoringPage() {
  const params = useParams<{ sourceId: string }>();
  const parsedSourceId = Number(params.sourceId);
  const sourcesQuery = useEventSourcesQuery();
  const sources = useMemo(
    () => sourcesQuery.data?.results ?? [],
    [sourcesQuery.data],
  );
  const source = sources.find((item) => item.id === parsedSourceId);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<ExternalEvent | null>(null);
  const selectedStatus =
    statusFilter === "all"
      ? undefined
      : (statusFilter as EventWorkflowStatus);
  const eventsQuery = useEventsQuery(
    {
      source: source?.id,
      workflow_status: selectedStatus,
      search: search.trim() || undefined,
    },
    Boolean(source),
  );
  const summaryQuery = useEventSummaryQuery(source?.id, Boolean(source));
  const events = useMemo(
    () => eventsQuery.data?.results ?? [],
    [eventsQuery.data],
  );
  const discoveredPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const event of events) {
      collectPayloadPaths(event.payload, "", 0, paths);
    }
    return [...paths].sort((a, b) => a.localeCompare(b));
  }, [events]);
  const columns = source
    ? effectiveColumns(source.columns, discoveredPaths).filter(
        (column) => column.visible,
      )
    : [];
  const summary = summaryQuery.data;
  const statusItems = { all: "All statuses", ...WORKFLOW_LABELS };

  if (sourcesQuery.isLoading) {
    return (
      <div className="h-full grid place-items-center text-[13px] text-muted-foreground">
        Loading monitoring page…
      </div>
    );
  }

  if (sourcesQuery.isError || !source) {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-[14px] font-medium">Monitoring page not found</p>
          <Button
            size="sm"
            variant="outline"
            render={<a href="/settings/incoming-webhooks" />}
          >
            Monitoring settings
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 border-b border-border/80 px-4 py-3 space-y-3">
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-lg bg-muted grid place-items-center">
            <MonitoringIcon name={source.icon} className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[16px] font-semibold tracking-tight truncate">
                {source.name}
              </h1>
              {!source.active && <Badge variant="outline">Paused</Badge>}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {PROVIDER_LABELS[source.provider]}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={<a href="/settings/incoming-webhooks" />}
          >
            <Settings2 /> Configure
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <SummaryChip
            label="Total"
            count={summary?.total ?? 0}
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          {(Object.keys(WORKFLOW_LABELS) as EventWorkflowStatus[]).map(
            (status) => (
              <SummaryChip
                key={status}
                label={WORKFLOW_LABELS[status]}
                count={summary?.[status] ?? 0}
                active={statusFilter === status}
                onClick={() => setStatusFilter(status)}
              />
            ),
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 max-w-sm flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search this page…"
              className="pl-8 h-8 text-[12px]"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(value) => value && setStatusFilter(value)}
            items={statusItems}
          >
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(WORKFLOW_LABELS) as EventWorkflowStatus[]).map(
                (status) => (
                  <SelectItem key={status} value={status}>
                    {WORKFLOW_LABELS[status]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {eventsQuery.isLoading ? (
          <div className="h-full grid place-items-center text-[13px] text-muted-foreground">
            Loading events…
          </div>
        ) : eventsQuery.isError ? (
          <div className="h-full grid place-items-center text-[13px] text-destructive">
            Couldn&apos;t load events.
          </div>
        ) : events.length === 0 ? (
          <div className="h-full grid place-items-center p-6 text-center">
            <div className="max-w-sm">
              <MonitoringIcon
                name={source.icon}
                className="size-8 mx-auto text-muted-foreground"
              />
              <p className="mt-3 text-[14px] font-medium">
                No matching events
              </p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Send a webhook to this page&apos;s URL or clear the current
                filters.
              </p>
            </div>
          </div>
        ) : (
          <table className="w-full min-w-max text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.id}
                    className="h-9 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap"
                  >
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
                  columns={columns}
                  onOpen={() => setSelectedEvent(event)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedEvent && (
        <EventDetails
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

function SummaryChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-6 px-2 rounded-md border text-[11px] transition-colors",
        active
          ? "border-foreground/25 bg-muted text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}{" "}
      <span className="ml-1 tabular-nums font-medium">{count}</span>
    </button>
  );
}

function EventRow({
  event,
  columns,
  onOpen,
}: {
  event: ExternalEvent;
  columns: MonitoringColumn[];
  onOpen: () => void;
}) {
  return (
    <tr
      onClick={onOpen}
      className="border-b border-border/60 hover:bg-muted/35 cursor-pointer transition-colors"
    >
      {columns.map((column) => (
        <td
          key={column.id}
          className={cn(
            "h-11 px-3 text-[12px] max-w-80",
            column.id === "title" && "min-w-64",
          )}
        >
          <EventCell event={event} column={column} />
        </td>
      ))}
    </tr>
  );
}

function EventCell({
  event,
  column,
}: {
  event: ExternalEvent;
  column: MonitoringColumn;
}) {
  if (column.id === "workflow_status") {
    return (
      <div onClick={(click) => click.stopPropagation()}>
        <WorkflowSelect event={event} />
      </div>
    );
  }
  if (column.id === "title") {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-medium truncate">{event.title}</span>
        {event.target_url && (
          <ExternalLink className="size-3 text-muted-foreground shrink-0" />
        )}
      </div>
    );
  }
  if (column.id === "severity") {
    return event.severity ? (
      <Badge variant="outline" className="font-normal capitalize">
        {event.severity}
      </Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  if (column.id === "provider_status") {
    return <span className="capitalize">{event.provider_status || "—"}</span>;
  }
  if (column.id === "event_type") {
    return (
      <span className="font-mono text-[11px]">{event.event_type || "—"}</span>
    );
  }
  if (column.id === "occurrence_count") {
    return <span className="tabular-nums">{event.occurrence_count}</span>;
  }
  if (column.id === "last_received_at") {
    return (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatEventDate(event.last_received_at)}
      </span>
    );
  }
  if (column.id === "occurred_at") {
    return (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatEventDate(event.occurred_at)}
      </span>
    );
  }
  if (column.id === "external_id") {
    return (
      <span className="font-mono text-[11px] text-muted-foreground">
        {event.external_id}
      </span>
    );
  }
  if (column.id.startsWith("payload:")) {
    const value = displayValue(
      valueAtPath(event.payload, column.id.slice("payload:".length)),
    );
    return (
      <span
        className="block truncate font-mono text-[11px] text-muted-foreground"
        title={value}
      >
        {value}
      </span>
    );
  }
  return <span>—</span>;
}

function WorkflowSelect({ event }: { event: ExternalEvent }) {
  const update = useUpdateEvent();
  return (
    <Select
      value={event.workflow_status}
      onValueChange={(value) =>
        value &&
        update.mutate({
          id: event.id,
          workflow_status: value as EventWorkflowStatus,
        })
      }
      items={WORKFLOW_LABELS}
      disabled={update.isPending}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "border-0 h-6 px-2 shadow-none text-[11px]",
          WORKFLOW_STYLES[event.workflow_status],
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(WORKFLOW_LABELS) as EventWorkflowStatus[]).map(
          (status) => (
            <SelectItem key={status} value={status}>
              {WORKFLOW_LABELS[status]}
            </SelectItem>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

function EventDetails({
  event,
  onClose,
}: {
  event: ExternalEvent;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-[760px] max-h-[85vh] p-0 gap-0 flex flex-col"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 py-4 border-b border-border/60">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-[15px] leading-snug">
                {event.title}
              </DialogTitle>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Received {formatEventDate(event.last_received_at)}
              </p>
            </div>
            {event.target_url && (
              <Button
                variant="outline"
                size="sm"
                render={
                  <a
                    href={event.target_url}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                Open provider <ExternalLink />
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap gap-4 text-[12px]">
            <Detail label="Cyt status">
              <WorkflowSelect event={event} />
            </Detail>
            <Detail label="Provider status">
              <span className="capitalize">{event.provider_status || "—"}</span>
            </Detail>
            <Detail label="Severity">
              <span className="capitalize">{event.severity || "—"}</span>
            </Detail>
            <Detail label="Occurrences">
              <span>{event.occurrence_count}</span>
            </Detail>
            <Detail label="External ID">
              <code className="text-[11px]">{event.external_id}</code>
            </Detail>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Raw payload
            </p>
            <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </div>
        </div>
        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex justify-end">
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}
