"use client";

/**
 * Metric slide-over — log a check-in, read & edit the full history.
 * Same backdrop + slide-in idiom as the task panel. Shared by /bets and
 * the home dashboard so the log history is one click away everywhere.
 */

import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAddCheckin,
  useDeleteCheckin,
  useDeleteMetric,
  useUpdateCheckin,
} from "@/hooks/use-bets";
import { formatDuration } from "@/components/task/TimeInColumn";
import type { Bet, BetMetric, MetricCheckin } from "@/lib/types";

import { paceOf, trimNumber } from "./MetricLine";

export function MetricSlideOver({
  bet,
  metric,
  period,
  onClose,
}: {
  bet: Bet;
  metric: BetMetric;
  period: string;
  onClose: () => void;
}) {
  const deleteMetric = useDeleteMetric();
  const latest = metric.checkins[0] ?? null;
  const latestValue = latest?.value ?? null;
  const pace =
    latestValue != null && metric.target != null
      ? paceOf(latestValue, metric.target, period)
      : null;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md flex flex-col bg-card border-l border-border shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="shrink-0 flex items-start gap-3 px-5 py-4 border-b border-border/60">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight truncate">
              {metric.name}
            </h2>
            <p className="text-[11px] text-muted-foreground truncate">
              <span
                className="inline-block size-1.5 rounded-full mr-1.5 align-middle"
                style={{ background: bet.color }}
              />
              {bet.name}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* Current reading */}
          <div>
            <div className="flex items-baseline gap-2">
              {latestValue != null ? (
                <>
                  <span className="font-mono text-[26px] font-semibold tabular-nums leading-none">
                    {trimNumber(latestValue)}
                  </span>
                  <span className="text-[12px] text-muted-foreground tabular-nums">
                    {metric.target != null && `of ${trimNumber(metric.target)}`}
                    {metric.unit && ` ${metric.unit}`}
                  </span>
                </>
              ) : latest ? (
                <span className="text-[13px] text-muted-foreground italic">
                  “{latest.note}”
                </span>
              ) : (
                <span className="text-[12px] text-muted-foreground/60">
                  No check-ins yet — log the first reading below.
                </span>
              )}
              {pace === "ahead" && (
                <span className="text-[10px] font-medium text-green-600 dark:text-green-400">
                  ▲ ahead of pace
                </span>
              )}
              {pace === "behind" && (
                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  ▼ behind pace
                </span>
              )}
            </div>
            {metric.target != null && (
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${latestValue != null ? Math.max(0, Math.min(100, (latestValue / metric.target) * 100)) : 0}%`,
                    background: bet.color,
                  }}
                />
              </div>
            )}
          </div>

          {/* Log form */}
          <CheckinForm metricId={metric.id} />

          {/* History — every entry editable in place, deletable. */}
          <div className="space-y-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              History
            </span>
            {metric.checkins.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Nothing logged yet.
              </p>
            )}
            {metric.checkins.map((c) => (
              <EditableCheckinRow key={c.id} checkin={c} />
            ))}
          </div>
        </div>

        {/* Housekeeping */}
        <div className="shrink-0 px-5 py-3 border-t border-border/60">
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete metric "${metric.name}" and its log?`)) {
                deleteMetric.mutate(metric.id, { onSuccess: onClose });
              }
            }}
            className="text-[11px] text-muted-foreground/70 hover:text-destructive transition-colors"
          >
            Delete metric
          </button>
        </div>
      </div>
    </>
  );
}

function CheckinForm({ metricId }: { metricId: number }) {
  const addCheckin = useAddCheckin();
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const canLog = value.trim() !== "" || note.trim() !== "";

  function submit() {
    if (!canLog || addCheckin.isPending) return;
    addCheckin.mutate(
      {
        metric: metricId,
        value: value.trim() === "" ? null : Number(value),
        note: note.trim(),
      },
      {
        onSuccess: () => {
          setValue("");
          setNote("");
        },
      },
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="#"
        autoFocus
        className="h-7 w-16 text-[12px] px-1.5"
      />
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Note (optional for numbers)"
        className="h-7 flex-1 text-[12px] px-1.5"
      />
      <Button
        size="sm"
        className="h-7 px-2.5 text-[12px]"
        disabled={!canLog || addCheckin.isPending}
        onClick={submit}
      >
        Log
      </Button>
    </div>
  );
}

function EditableCheckinRow({ checkin }: { checkin: MetricCheckin }) {
  const updateCheckin = useUpdateCheckin();
  const deleteCheckin = useDeleteCheckin();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    checkin.value != null ? String(checkin.value) : "",
  );
  const [note, setNote] = useState(checkin.note);
  const canSave = value.trim() !== "" || note.trim() !== "";

  function save() {
    if (!canSave || updateCheckin.isPending) return;
    updateCheckin.mutate(
      {
        id: checkin.id,
        value: value.trim() === "" ? null : Number(value),
        note: note.trim(),
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="#"
          autoFocus
          className="h-6 w-16 text-[11px] px-1.5"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="Note"
          className="h-6 flex-1 text-[11px] px-1.5"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-1.5 text-[11px]"
          disabled={!canSave || updateCheckin.isPending}
          onClick={save}
          aria-label="Save check-in"
        >
          <Check className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => {
            setValue(checkin.value != null ? String(checkin.value) : "");
            setNote(checkin.note);
            setEditing(false);
          }}
          aria-label="Cancel edit"
        >
          <X className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 text-[12px] leading-tight">
      <span className="size-1 rounded-full bg-muted-foreground/40 mt-1.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">
          {checkin.value != null && (
            <span className="font-mono font-medium tabular-nums">
              {trimNumber(checkin.value)}
            </span>
          )}
          {checkin.value != null && checkin.note && (
            <span className="text-muted-foreground"> · </span>
          )}
          {checkin.note}
        </span>
        <div className="text-[11px] text-muted-foreground/80">
          {checkin.created_by?.username ?? "agent"} ·{" "}
          {formatDuration(checkin.created_at)} ago
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit check-in"
          className="text-muted-foreground/60 hover:text-foreground transition-colors p-0.5"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => deleteCheckin.mutate(checkin.id)}
          aria-label="Delete check-in"
          className="text-muted-foreground/60 hover:text-destructive transition-colors p-0.5"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
