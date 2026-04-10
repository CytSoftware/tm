"use client";

import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { humanizeRrule, previewOccurrences } from "@/lib/rrule";

export type SchedulePreset =
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

const PRESET_LABELS: Record<SchedulePreset, string> = {
  daily: "Daily",
  weekdays: "Every weekday",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom RRULE",
};

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export type RecurrenceState = {
  enabled: boolean;
  preset: SchedulePreset;
  weekdays: Weekday[];
  monthDay: number;
  customRrule: string;
  dtstartLocal: string; // datetime-local format
};

const WEEKDAY_LABELS: Array<[Weekday, string]> = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
  ["SA", "Sat"],
  ["SU", "Sun"],
];

type Props = {
  state: RecurrenceState;
  onChange: (next: RecurrenceState) => void;
};

export function RecurrencePicker({ state, onChange }: Props) {
  const update = (patch: Partial<RecurrenceState>) =>
    onChange({ ...state, ...patch });

  const rrule = useMemo(() => buildRrule(state), [state]);
  const humanized = rrule ? humanizeRrule(rrule) : "";
  const occurrences = useMemo(() => {
    if (!rrule || !state.dtstartLocal) return [];
    const dt = new Date(state.dtstartLocal);
    if (Number.isNaN(dt.getTime())) return [];
    return previewOccurrences(rrule, dt, 3);
  }, [rrule, state.dtstartLocal]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Frequency
          </Label>
          <Select
            value={state.preset}
            onValueChange={(v) => update({ preset: v as SchedulePreset })}
            items={PRESET_LABELS}
          >
            <SelectTrigger className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABELS) as SchedulePreset[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {PRESET_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Starting
          </Label>
          <Input
            type="datetime-local"
            value={state.dtstartLocal}
            onChange={(e) => update({ dtstartLocal: e.target.value })}
            className="h-9 text-[13px]"
          />
        </div>
      </div>

      {state.preset === "weekly" && (
        <div className="space-y-1">
          <Label className="text-xs">Days of the week</Label>
          <div className="flex gap-1">
            {WEEKDAY_LABELS.map(([code, label]) => {
              const active = state.weekdays.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() =>
                    update({
                      weekdays: active
                        ? state.weekdays.filter((d) => d !== code)
                        : [...state.weekdays, code],
                    })
                  }
                  className={`rounded border px-2 py-1 text-xs ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {state.preset === "monthly" && (
        <div className="space-y-1">
          <Label className="text-xs">Day of month</Label>
          <Input
            type="number"
            min={1}
            max={31}
            value={state.monthDay}
            onChange={(e) =>
              update({ monthDay: Math.max(1, Math.min(31, Number(e.target.value))) })
            }
          />
        </div>
      )}

      {state.preset === "custom" && (
        <div className="space-y-1">
          <Label className="text-xs">RRULE</Label>
          <Input
            value={state.customRrule}
            placeholder="FREQ=DAILY;BYHOUR=9"
            onChange={(e) => update({ customRrule: e.target.value })}
            className="font-mono text-xs"
          />
        </div>
      )}

      {humanized && (
        <div className="text-xs text-muted-foreground">
          <div>Schedule: {humanized}</div>
          {occurrences.length > 0 && (
            <div className="mt-1">
              Next runs:{" "}
              {occurrences.map((d) => d.toLocaleString()).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function buildRrule(state: RecurrenceState): string | null {
  switch (state.preset) {
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly": {
      const days = state.weekdays.join(",");
      return days ? `FREQ=WEEKLY;BYDAY=${days}` : "FREQ=WEEKLY";
    }
    case "monthly":
      return `FREQ=MONTHLY;BYMONTHDAY=${state.monthDay}`;
    case "custom":
      return state.customRrule.trim() || null;
  }
}
