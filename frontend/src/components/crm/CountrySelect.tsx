"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { COUNTRIES, countryName } from "@/lib/countries";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  className?: string;
  /** Render as a small pill (used in the filter bar). */
  compact?: boolean;
};

export function CountrySelect({
  value,
  onChange,
  placeholder = "Country",
  className,
  compact,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.code.toLowerCase().startsWith(q) ||
        c.name.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size={compact ? "sm" : "default"}
            className={cn(
              "justify-between font-normal",
              compact ? "h-7 text-[12px]" : "h-9",
              !value && "text-muted-foreground",
              className,
            )}
          >
            <span className="truncate">
              {value ? `${value} · ${countryName(value)}` : placeholder}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72 p-0">
        <div className="p-2 border-b border-border/60">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search countries…"
              className="h-8 pl-7 text-[12px]"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {value && (
            <button
              type="button"
              className="w-full px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-muted/60"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear country
            </button>
          )}
          {filtered.map((c) => {
            const selected = c.code === value;
            return (
              <button
                key={c.code}
                type="button"
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/60",
                  selected && "bg-muted/40",
                )}
                onClick={() => {
                  onChange(c.code);
                  setOpen(false);
                }}
              >
                <span className="font-mono text-[10px] text-muted-foreground w-6">
                  {c.code}
                </span>
                <span className="truncate flex-1">{c.name}</span>
                {selected && <Check className="size-3.5" />}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-muted-foreground italic">
              No matches.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
