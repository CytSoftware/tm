"use client";

import { Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CountrySelect } from "@/components/crm/CountrySelect";
import { useContactLabelsQuery } from "@/hooks/use-contacts";
import { EMPTY_CONTACT_FILTERS, type ContactFilters } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  filters: ContactFilters;
  onChange: (filters: ContactFilters) => void;
};

export function ContactFilterBar({ filters, onChange }: Props) {
  const labelsQuery = useContactLabelsQuery();

  function patch(p: Partial<ContactFilters>) {
    onChange({ ...filters, ...p });
  }

  function toggleLabel(id: number) {
    const has = filters.labelIds.includes(id);
    patch({
      labelIds: has
        ? filters.labelIds.filter((x) => x !== id)
        : [...filters.labelIds, id],
    });
  }

  const activeFilterCount =
    (filters.country ? 1 : 0) +
    (filters.city.trim() ? 1 : 0) +
    (filters.industry.trim() ? 1 : 0) +
    (filters.jobTitle.trim() ? 1 : 0) +
    filters.labelIds.length +
    (filters.hasEmail !== null ? 1 : 0) +
    (filters.hasPhone !== null ? 1 : 0) +
    (filters.hasLinkedin !== null ? 1 : 0) +
    (filters.hasWebsite !== null ? 1 : 0);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Search */}
      <div className="relative flex-1 max-w-md min-w-48">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) => patch({ search: e.target.value })}
          placeholder="Search name, email, company, notes…"
          className="h-8 pl-8 text-[13px]"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => patch({ search: "" })}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Country */}
      <CountrySelect
        value={filters.country}
        onChange={(code) => patch({ country: code })}
        placeholder="Country"
        compact
      />

      {/* City */}
      <Input
        value={filters.city}
        onChange={(e) => patch({ city: e.target.value })}
        placeholder="City"
        className="h-7 w-32 text-[12px]"
      />

      {/* Industry (free-text icontains) */}
      <Input
        value={filters.industry}
        onChange={(e) => patch({ industry: e.target.value })}
        placeholder="Industry"
        className="h-7 w-32 text-[12px]"
      />

      {/* Job title (free-text icontains) */}
      <Input
        value={filters.jobTitle}
        onChange={(e) => patch({ jobTitle: e.target.value })}
        placeholder="Job title"
        className="h-7 w-32 text-[12px]"
      />

      {/* Labels */}
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="sm" className="h-7 text-[12px]">
              Labels
              {filters.labelIds.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-4 px-1.5">
                  {filters.labelIds.length}
                </Badge>
              )}
            </Button>
          }
        />
        <PopoverContent align="start" className="w-56 p-1">
          <div className="max-h-64 overflow-y-auto">
            {(labelsQuery.data ?? []).map((l) => {
              const checked = filters.labelIds.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => toggleLabel(l.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-muted/60",
                    checked && "bg-muted/40",
                  )}
                >
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: l.color }}
                  />
                  <span className="truncate flex-1 text-left">{l.name}</span>
                  {checked && <span className="text-[10px]">✓</span>}
                </button>
              );
            })}
            {(labelsQuery.data ?? []).length === 0 && (
              <div className="px-2 py-2 text-[12px] text-muted-foreground italic">
                No labels yet.
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Has-X toggles */}
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="sm" className="h-7 text-[12px]">
              More
            </Button>
          }
        />
        <PopoverContent align="start" className="w-64 p-3 space-y-2">
          <ToggleRow
            label="Has email"
            value={filters.hasEmail}
            onChange={(v) => patch({ hasEmail: v })}
          />
          <ToggleRow
            label="Has phone"
            value={filters.hasPhone}
            onChange={(v) => patch({ hasPhone: v })}
          />
          <ToggleRow
            label="Has LinkedIn"
            value={filters.hasLinkedin}
            onChange={(v) => patch({ hasLinkedin: v })}
          />
          <ToggleRow
            label="Has website"
            value={filters.hasWebsite}
            onChange={(v) => patch({ hasWebsite: v })}
          />
        </PopoverContent>
      </Popover>

      {activeFilterCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[12px] text-muted-foreground"
          onClick={() => onChange({ ...EMPTY_CONTACT_FILTERS, search: filters.search })}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px]">{label}</span>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={value === true ? "default" : "outline"}
          className="h-6 px-2 text-[11px]"
          onClick={() => onChange(value === true ? null : true)}
        >
          Yes
        </Button>
        <Button
          size="sm"
          variant={value === false ? "default" : "outline"}
          className="h-6 px-2 text-[11px]"
          onClick={() => onChange(value === false ? null : false)}
        >
          No
        </Button>
      </div>
    </div>
  );
}
