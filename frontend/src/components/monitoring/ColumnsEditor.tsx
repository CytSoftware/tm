"use client";

import { ArrowDown, ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SYSTEM_COLUMNS } from "@/lib/monitoring";
import type { MonitoringColumn } from "@/lib/types";

export function ColumnsEditor({
  columns,
  onChange,
}: {
  columns: MonitoringColumn[];
  onChange: (columns: MonitoringColumn[]) => void;
}) {
  const visibleCount = columns.filter((column) => column.visible).length;

  function toggle(index: number) {
    onChange(
      columns.map((column, current) =>
        current === index
          ? { ...column, visible: !column.visible }
          : column,
      ),
    );
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function reset() {
    const payload = columns
      .filter((column) => column.id.startsWith("payload:"))
      .map((column) => ({ ...column, visible: false }));
    onChange([...SYSTEM_COLUMNS, ...payload]);
  }

  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border/60 flex items-center gap-3">
        <div className="flex-1">
          <h2 className="text-[13px] font-medium">Page columns</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Payload fields appear here after this source sends them.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reset}>
          Reset
        </Button>
      </div>
      <div className="divide-y divide-border/50">
        {columns.map((column, index) => (
          <div key={column.id} className="flex items-center gap-2 px-4 py-2">
            <Checkbox
              checked={column.visible}
              disabled={column.visible && visibleCount === 1}
              onCheckedChange={() => toggle(index)}
            />
            <button
              type="button"
              className="flex-1 min-w-0 text-left"
              onClick={() => toggle(index)}
            >
              <span className="block text-[12px] truncate">{column.label}</span>
              {column.id.startsWith("payload:") && (
                <span className="block text-[10px] font-mono text-muted-foreground truncate">
                  {column.id.slice(8)}
                </span>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Move ${column.label} up`}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={index === columns.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Move ${column.label} down`}
            >
              <ArrowDown />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
