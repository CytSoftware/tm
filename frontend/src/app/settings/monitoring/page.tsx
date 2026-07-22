"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { ColumnsEditor } from "@/components/monitoring/ColumnsEditor";
import { Button } from "@/components/ui/button";
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
  useUpdateEventSource,
} from "@/hooks/use-events";
import {
  collectPayloadPaths,
  effectiveColumns,
  MONITORING_ICON_OPTIONS,
  MonitoringIcon,
  PROVIDER_LABELS,
} from "@/lib/monitoring";
import { cn } from "@/lib/utils";
import type {
  EventPageIcon,
  EventProvider,
  EventSource,
  MonitoringColumn,
} from "@/lib/types";

export default function MonitoringSettingsPage() {
  const router = useRouter();
  const sourcesQuery = useEventSourcesQuery();
  const sources = useMemo(
    () => sourcesQuery.data?.results ?? [],
    [sourcesQuery.data],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const selected =
    sources.find((source) => source.id === selectedId) ?? sources[0] ?? null;

  if (sourcesQuery.isLoading) {
    return (
      <div className="h-full grid place-items-center text-[13px] text-muted-foreground">
        Loading monitoring settings…
      </div>
    );
  }

  if (sourcesQuery.isError) {
    return (
      <div className="h-full grid place-items-center text-[13px] text-destructive">
        Couldn&apos;t load monitoring sources.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 h-14 px-4 border-b border-border/80 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => router.back()}
          aria-label="Back"
        >
          <ArrowLeft />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-semibold tracking-tight">
            Monitoring
          </h1>
          <p className="text-[11px] text-muted-foreground">
            Configure webhook-backed pages and their sidebar presentation.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus /> New page
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex">
        <aside className="w-60 shrink-0 border-r border-border/80 p-2 overflow-y-auto">
          {sources.length === 0 ? (
            <p className="px-2 py-4 text-[12px] text-muted-foreground text-center">
              No monitoring pages yet.
            </p>
          ) : (
            <div className="space-y-0.5">
              {sources.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => setSelectedId(source.id)}
                  className={cn(
                    "w-full h-8 rounded-md px-2 flex items-center gap-2 text-[12px] text-left transition-colors",
                    selected?.id === source.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <MonitoringIcon name={source.icon} className="size-3.5" />
                  <span className="truncate">{source.name}</span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
          {selected ? (
            <SourceEditor key={selected.id} source={selected} />
          ) : (
            <div className="h-full grid place-items-center p-6 text-center">
              <div className="max-w-sm space-y-3">
                <MonitoringIcon
                  name="activity"
                  className="size-8 mx-auto text-muted-foreground"
                />
                <div>
                  <p className="text-[14px] font-medium">
                    Create a monitoring page
                  </p>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    Each webhook source gets its own page, icon, and columns.
                  </p>
                </div>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus /> New page
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>

      {createOpen && (
        <CreateSourceDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(source) => {
            setSelectedId(source.id);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SourceEditor({ source }: { source: EventSource }) {
  const [name, setName] = useState(source.name);
  const [provider, setProvider] = useState(source.provider);
  const [icon, setIcon] = useState(source.icon);
  const [active, setActive] = useState(source.active);
  const [columns, setColumns] = useState<MonitoringColumn[]>(source.columns);
  const [copied, setCopied] = useState(false);
  const update = useUpdateEventSource(source.id);
  const remove = useDeleteEventSource();
  const eventsQuery = useEventsQuery({ source: source.id });
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
  const configuredColumns = useMemo(
    () => effectiveColumns(columns, discoveredPaths),
    [columns, discoveredPaths],
  );

  async function copyUrl() {
    await navigator.clipboard.writeText(source.webhook_url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function save() {
    if (!name.trim()) return;
    update.mutate({
      name: name.trim(),
      provider,
      icon,
      active,
      columns: configuredColumns,
    });
  }

  function deleteSource() {
    if (
      confirm(
        `Delete "${source.name}" and every event received through it?`,
      )
    ) {
      remove.mutate(source.id);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-muted grid place-items-center shrink-0">
          <MonitoringIcon name={icon} className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold">{source.name}</h2>
          <p className="text-[11px] text-muted-foreground">
            {PROVIDER_LABELS[source.provider]} monitoring page
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<a href={`/monitoring/${source.id}`} />}
        >
          Preview <ExternalLink />
        </Button>
      </div>

      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">
              Page name
            </Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-[12px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">
              Provider
            </Label>
            <Select
              value={provider}
              onValueChange={(value) =>
                value && setProvider(value as EventProvider)
              }
              items={PROVIDER_LABELS}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PROVIDER_LABELS) as EventProvider[]).map(
                  (item) => (
                    <SelectItem key={item} value={item}>
                      {PROVIDER_LABELS[item]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Page icon</Label>
          <div className="flex flex-wrap gap-1.5">
            {MONITORING_ICON_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setIcon(option)}
                className={cn(
                  "size-8 rounded-md border grid place-items-center transition-colors",
                  icon === option
                    ? "border-foreground/30 bg-muted"
                    : "border-border hover:bg-muted/60",
                )}
                aria-label={`${option} icon`}
              >
                <MonitoringIcon name={option} className="size-3.5" />
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[12px]">Receive new webhooks</p>
            <p className="text-[10px] text-muted-foreground">
              Turning this off keeps the page but rejects incoming requests.
            </p>
          </div>
          <Switch checked={active} onCheckedChange={setActive} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Webhook URL
          </Label>
          <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5">
            <code className="flex-1 min-w-0 truncate text-[10px] text-muted-foreground">
              {source.webhook_url}
            </code>
            <Button variant="ghost" size="xs" onClick={copyUrl}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            The URL contains a private token. Delete and recreate the page if
            it is exposed.
          </p>
        </div>
      </section>

      <ColumnsEditor columns={configuredColumns} onChange={setColumns} />

      {update.isError && (
        <p className="text-[11px] text-destructive">
          Couldn&apos;t save this monitoring page.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={!name.trim() || update.isPending}>
          {update.isPending ? "Saving…" : "Save page"}
        </Button>
        {update.isSuccess && (
          <span className="text-[11px] text-green-600">Saved</span>
        )}
        <Button
          variant="destructive"
          className="ml-auto"
          onClick={deleteSource}
          disabled={remove.isPending}
        >
          <Trash2 /> Delete page
        </Button>
      </div>
    </div>
  );
}

function CreateSourceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (source: EventSource) => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<EventProvider>("generic");
  const [icon, setIcon] = useState<EventPageIcon>("activity");
  const create = useCreateEventSource();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), provider, icon },
      { onSuccess: onCreated },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px] p-0 gap-0" showCloseButton={false}>
        <div className="px-5 py-4 border-b border-border/60">
          <DialogTitle className="text-[15px]">New monitoring page</DialogTitle>
          <p className="mt-1 text-[11px] text-muted-foreground">
            This creates both the webhook source and its sidebar page.
          </p>
        </div>
        <form onSubmit={submit}>
          <div className="px-5 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                Page name
              </Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Website uptime"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                Provider
              </Label>
              <Select
                value={provider}
                onValueChange={(value) =>
                  value && setProvider(value as EventProvider)
                }
                items={PROVIDER_LABELS}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVIDER_LABELS) as EventProvider[]).map(
                    (item) => (
                      <SelectItem key={item} value={item}>
                        {PROVIDER_LABELS[item]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Icon</Label>
              <div className="flex flex-wrap gap-1.5">
                {MONITORING_ICON_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setIcon(option)}
                    className={cn(
                      "size-8 rounded-md border grid place-items-center",
                      icon === option
                        ? "border-foreground/30 bg-muted"
                        : "border-border hover:bg-muted/60",
                    )}
                  >
                    <MonitoringIcon name={option} className="size-3.5" />
                  </button>
                ))}
              </div>
            </div>
            {create.isError && (
              <p className="text-[11px] text-destructive">
                Couldn&apos;t create the monitoring page.
              </p>
            )}
          </div>
          <div className="px-5 py-3 border-t border-border/60 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create page
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
