"use client";

import { useState } from "react";
import { Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/UserAvatar";
import {
  useDeletePipeline,
  useLogPipelineEvent,
  usePipelineEventsQuery,
  usePipelineQuery,
  usePipelineStagesQuery,
  useUpdatePipeline,
} from "@/hooks/use-pipelines";
import type { PipelineEventEntry } from "@/lib/types";

type Props = {
  pipelineKey: string | null;
  onClose: () => void;
};

export function PipelinePanel({ pipelineKey, onClose }: Props) {
  const pipelineQuery = usePipelineQuery(pipelineKey);
  const eventsQuery = usePipelineEventsQuery(pipelineKey);
  const stagesQuery = usePipelineStagesQuery();
  const updatePipeline = useUpdatePipeline();
  const deletePipeline = useDeletePipeline();
  const logEvent = useLogPipelineEvent();

  const pipeline = pipelineQuery.data;

  // base-ui's <SelectValue /> falls back to the raw `value` string unless
  // the <Select> root receives an `items` map of value→label. Build it from
  // the stages list (stage id, stringified, → stage name).
  const stageItems: Record<string, string> = {};
  for (const s of stagesQuery.data ?? []) {
    stageItems[String(s.id)] = s.name;
  }

  // Local edit buffer — flushed on blur per-field. Seeded from the loaded
  // pipeline using the "store info from previous renders" pattern so an
  // effect+setState (eslint flags it) isn't needed.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [description, setDescription] = useState("");

  if (pipeline && seededFor !== pipeline.key) {
    setSeededFor(pipeline.key);
    setTitle(pipeline.title);
    setCounterparty(pipeline.counterparty);
    setDescription(pipeline.description);
  }

  const [eventBody, setEventBody] = useState("");

  if (!pipelineKey) return null;

  function patch(payload: Record<string, unknown>) {
    if (!pipelineKey) return;
    updatePipeline.mutate({ key: pipelineKey, ...payload });
  }

  function handleAddEvent() {
    if (!pipelineKey) return;
    if (!eventBody.trim()) return;
    logEvent.mutate(
      { key: pipelineKey, body: eventBody.trim() },
      {
        onSuccess: () => setEventBody(""),
      },
    );
  }

  function handleDelete() {
    if (!pipelineKey) return;
    if (!confirm(`Delete pipeline ${pipelineKey}? This cannot be undone.`))
      return;
    deletePipeline.mutate(pipelineKey, {
      onSuccess: () => onClose(),
    });
  }

  return (
    <aside className="shrink-0 w-[400px] h-full flex flex-col border-l border-border/80 bg-background">
      <header className="shrink-0 flex items-center gap-2 px-4 h-12 border-b border-border/80">
        <span className="font-mono text-[11px] text-muted-foreground tracking-wider uppercase">
          {pipelineKey}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={handleDelete}
          aria-label="Delete pipeline"
        >
          <Trash2 className="size-3.5 text-destructive" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {pipelineQuery.isLoading && (
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        )}
        {pipeline && (
          <>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">
                Title
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  if (title.trim() && title !== pipeline.title) {
                    patch({ title: title.trim() });
                  }
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">
                Stage
              </label>
              <Select
                value={String(pipeline.stage.id)}
                onValueChange={(v) => patch({ stage_id: Number(v) })}
                items={stageItems}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(stagesQuery.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">
                Counterparty
              </label>
              <Input
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                onBlur={() => {
                  if (counterparty !== pipeline.counterparty) {
                    patch({ counterparty });
                  }
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">
                Description
              </label>
              <Textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (description !== pipeline.description) {
                    patch({ description });
                  }
                }}
              />
            </div>

            {/* Timeline */}
            <div className="pt-2 border-t border-border/60 space-y-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Timeline
              </div>

              <div className="space-y-2">
                <Textarea
                  rows={2}
                  placeholder="Add a timeline entry…"
                  value={eventBody}
                  onChange={(e) => setEventBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleAddEvent();
                    }
                  }}
                />
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    ⌘/Ctrl+Enter to log
                  </span>
                  <Button
                    size="sm"
                    onClick={handleAddEvent}
                    disabled={!eventBody.trim() || logEvent.isPending}
                  >
                    {logEvent.isPending ? "Logging..." : "Log entry"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {(eventsQuery.data ?? []).length === 0 && (
                  <div className="text-[12px] text-muted-foreground italic">
                    No events yet.
                  </div>
                )}
                {(eventsQuery.data ?? [])
                  .slice()
                  .reverse()
                  .map((e) => (
                    <EventItem key={e.id} event={e} />
                  ))}
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function EventItem({ event }: { event: PipelineEventEntry }) {
  const created = new Date(event.created_at);
  return (
    <div className="rounded-md border border-border/60 bg-card px-3 py-2 space-y-1">
      <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        {event.author && (
          <>
            <UserAvatar
              username={event.author.username}
              avatarUrl={event.author.avatar_url}
              size="size-4"
            />
            <span>{event.author.username}</span>
            <span>·</span>
          </>
        )}
        <span title={created.toLocaleString()}>
          {created.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </div>
      {event.body && (
        <div className="text-[12px] whitespace-pre-wrap break-words">
          {event.body}
        </div>
      )}
    </div>
  );
}
