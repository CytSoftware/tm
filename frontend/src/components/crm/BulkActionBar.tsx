"use client";

/**
 * Floating action bar that appears above the contacts table when one or
 * more rows are selected. Supports two selection modes:
 *
 *   1. **Page-level**: explicit set of keys chosen via the row checkboxes.
 *   2. **All matching**: every contact that matches the current filter,
 *      regardless of how many pages it spans. The user opts in by clicking
 *      the "Select all N matching" link that surfaces once the visible
 *      page is fully selected.
 *
 * The mode is encoded here so the page just renders the bar and forwards
 * a compact set of inputs.
 */

import { Loader2, Tag, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  contactFiltersToBackendDict,
  useBulkDeleteContacts,
  useBulkLabelContacts,
  useContactLabelsQuery,
} from "@/hooks/use-contacts";
import type { ContactFilters } from "@/lib/types";
import { cn } from "@/lib/utils";

type Mode = "page" | "all-matching";

type Props = {
  mode: Mode;
  /** Keys explicitly selected when ``mode === "page"``. Ignored for
   *  ``"all-matching"`` (the server re-applies the filter). */
  selectedKeys: string[];
  /** Total rows matching the current filter — used for the offer banner
   *  and the "all matching" count display. */
  totalMatching: number;
  /** Whether every visible row on the current page is selected. Drives the
   *  "Select all N matching" affordance. */
  pageFullySelected: boolean;
  filters: ContactFilters;
  onClear: () => void;
  onSwitchToAllMatching: () => void;
  onAfterMutation: () => void;
};

export function BulkActionBar({
  mode,
  selectedKeys,
  totalMatching,
  pageFullySelected,
  filters,
  onClear,
  onSwitchToAllMatching,
  onAfterMutation,
}: Props) {
  const labelsQuery = useContactLabelsQuery();
  const bulkDelete = useBulkDeleteContacts();
  const bulkLabel = useBulkLabelContacts();

  // The bar should hide entirely when nothing is selected.
  const visibleCount = mode === "all-matching" ? totalMatching : selectedKeys.length;
  if (visibleCount === 0) return null;

  function buildSelector():
    | { keys: string[] }
    | { select_all: true; filters: Record<string, unknown> } {
    if (mode === "all-matching") {
      return {
        select_all: true as const,
        filters: contactFiltersToBackendDict(filters),
      };
    }
    return { keys: selectedKeys };
  }

  function handleDelete() {
    const noun = visibleCount === 1 ? "contact" : "contacts";
    if (
      !confirm(`Delete ${visibleCount.toLocaleString()} ${noun}? This cannot be undone.`)
    )
      return;
    bulkDelete.mutate(buildSelector(), {
      onSuccess: () => {
        onAfterMutation();
      },
    });
  }

  function handleLabelOp(labelId: number, op: "add" | "remove") {
    const sel = buildSelector();
    bulkLabel.mutate(
      "keys" in sel
        ? { keys: sel.keys, label_ids: [labelId], action: op }
        : {
            select_all: sel.select_all,
            filters: sel.filters,
            label_ids: [labelId],
            action: op,
          },
    );
    // Don't clear selection on label ops — user may want to chain a few.
  }

  const busy = bulkDelete.isPending || bulkLabel.isPending;
  // Only offer the upgrade if there are extra matching rows and we're in
  // page mode and the visible page is fully ticked.
  const extraMatching = Math.max(0, totalMatching - selectedKeys.length);
  const showAllMatchingOffer =
    mode === "page" && pageFullySelected && extraMatching > 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-border/60",
        mode === "all-matching" ? "bg-amber-100/40 dark:bg-amber-900/20" : "bg-primary/5",
      )}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="text-[12px] font-medium">
        {mode === "all-matching"
          ? `All ${totalMatching.toLocaleString()} matching selected`
          : `${selectedKeys.length.toLocaleString()} selected`}
      </span>

      {showAllMatchingOffer && (
        <Button
          variant="link"
          size="sm"
          className="h-6 px-1 text-[12px]"
          onClick={onSwitchToAllMatching}
        >
          Select all {totalMatching.toLocaleString()} matching →
        </Button>
      )}

      <div className="flex-1" />

      <LabelMenu
        labels={labelsQuery.data ?? []}
        mode="add"
        onPick={(id) => handleLabelOp(id, "add")}
        disabled={busy}
      />
      <LabelMenu
        labels={labelsQuery.data ?? []}
        mode="remove"
        onPick={(id) => handleLabelOp(id, "remove")}
        disabled={busy}
      />

      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={handleDelete}
        disabled={busy}
      >
        {bulkDelete.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
        Delete
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-muted-foreground"
        onClick={onClear}
        disabled={busy}
      >
        <X className="size-3.5" />
        Clear
      </Button>
    </div>
  );
}

function LabelMenu({
  labels,
  mode,
  onPick,
  disabled,
}: {
  labels: { id: number; name: string; color: string }[];
  mode: "add" | "remove";
  onPick: (id: number) => void;
  disabled?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            disabled={disabled}
          >
            <Tag className="size-3.5" />
            {mode === "add" ? "Add label" : "Remove label"}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-56 p-1">
        <div className="max-h-64 overflow-y-auto">
          {labels.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-muted-foreground italic">
              No labels yet.
            </div>
          )}
          {labels.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => onPick(l.id)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-muted/60"
            >
              <span
                className="size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: l.color }}
              />
              <span className="truncate flex-1 text-left">{l.name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
