"use client";

/**
 * CRM page — flat contact table with server-side pagination, filtering,
 * sorting, and search. Slide-out detail panel for editing.
 *
 * Layout invariant (see CLAUDE.md "Frontend scroll invariant"):
 *   This page is the immediate child of the app shell — it must use
 *   ``h-full flex flex-col`` and every flex child that hosts a scroll area
 *   needs ``min-h-0``. The table itself is the only scroll surface.
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Plus, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BulkActionBar } from "@/components/crm/BulkActionBar";
import { ContactFilterBar } from "@/components/crm/ContactFilterBar";
import { ContactPanel } from "@/components/crm/ContactPanel";
import {
  ContactsTable,
  type HeaderSelectionState,
} from "@/components/crm/ContactsTable";
import { CreateContactDialog } from "@/components/crm/CreateContactDialog";
import { ImportDialog } from "@/components/crm/ImportDialog";
import { LabelManager } from "@/components/crm/LabelManager";
import {
  DEFAULT_CONTACT_PAGE_SIZE,
  triggerContactExport,
  useContactsQuery,
} from "@/hooks/use-contacts";
import {
  EMPTY_CONTACT_FILTERS,
  type ContactFilters,
  type ContactSortField,
} from "@/lib/types";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

export default function CrmPage() {
  const [filters, setFilters] = useState<ContactFilters>(EMPTY_CONTACT_FILTERS);
  const [sortField, setSortField] = useState<ContactSortField | null>(
    "created_at",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_CONTACT_PAGE_SIZE);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Bulk-selection state — Set of contact keys, accumulated across pages.
  // Cleared when filters/sort change (since the visible set changes too).
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  // When true, bulk operations target every row that matches the current
  // filter — not just the rows in ``bulkSelected``. The page-level
  // checkbox is only an entry point; the user opts in via the
  // "Select all N matching" link in the action bar.
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  const query = useContactsQuery({
    filters,
    sortField,
    sortDir,
    page,
    pageSize,
  });

  const totalPages = useMemo(() => {
    if (!query.data) return 1;
    return Math.max(1, Math.ceil(query.data.count / pageSize));
  }, [query.data, pageSize]);

  // Reset to page 1 whenever filters/sort/pageSize change. The query keys
  // already vary by all of these, so the only side effect is jumping back.
  // Selection clears too — the visible set has changed and re-applying old
  // selections to a different filter universe is more confusing than useful.
  function changeFilters(next: ContactFilters) {
    setFilters(next);
    setPage(1);
    setBulkSelected(new Set());
    setSelectAllMatching(false);
  }

  function changeSort(field: ContactSortField, dir: "asc" | "desc") {
    setSortField(field);
    setSortDir(dir);
    setPage(1);
    setBulkSelected(new Set());
    setSelectAllMatching(false);
  }

  function changePageSize(size: number) {
    setPageSize(size);
    setPage(1);
    setBulkSelected(new Set());
    setSelectAllMatching(false);
  }

  function toggleRow(key: string) {
    // Touching a single-row checkbox while in "all-matching" mode is a
    // tricky UX (deselecting one row out of the universal set). Treat it
    // as a downgrade: drop back to the explicit-keys mode and start fresh
    // with just this key inverted.
    if (selectAllMatching) {
      setSelectAllMatching(false);
      setBulkSelected(new Set([key]));
      return;
    }
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearBulk() {
    setBulkSelected(new Set());
    setSelectAllMatching(false);
  }

  async function handleExport() {
    setExporting(true);
    try {
      await triggerContactExport(filters);
    } catch (err) {
      console.error(err);
      alert(`Export failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setExporting(false);
    }
  }

  const contacts = query.data?.results ?? [];
  const total = query.data?.count ?? 0;
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  // Tri-state header checkbox derived from current page + selection.
  const pageKeys = contacts.map((c) => c.key);
  const selectedOnPage = pageKeys.filter((k) => bulkSelected.has(k)).length;
  // In "all-matching" mode the header always reads as "all".
  const headerSelection: HeaderSelectionState = selectAllMatching
    ? "all"
    : selectedOnPage === 0
      ? "none"
      : selectedOnPage === pageKeys.length && pageKeys.length > 0
        ? "all"
        : "some";

  function toggleAllOnPage() {
    if (selectAllMatching) {
      // Cancel "all matching" mode entirely — easiest predictable behaviour.
      setSelectAllMatching(false);
      setBulkSelected(new Set());
      return;
    }
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (headerSelection === "all") {
        for (const k of pageKeys) next.delete(k);
      } else {
        for (const k of pageKeys) next.add(k);
      }
      return next;
    });
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-row">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* Header */}
        <header className="shrink-0 px-4 h-12 flex items-center gap-2 border-b border-border/80">
          <h1 className="text-[14px] font-semibold tracking-tight">Contacts</h1>
          <span className="text-[12px] text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? "contact" : "contacts"}
          </span>
          <div className="flex-1" />
          <LabelManager />
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="size-3.5" />
            Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={exporting}
            onClick={handleExport}
          >
            <Download className="size-3.5" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New contact
          </Button>
        </header>

        {/* Filter bar */}
        <div className="shrink-0 px-4 py-2 border-b border-border/60">
          <ContactFilterBar filters={filters} onChange={changeFilters} />
        </div>

        {/* Bulk action bar — only renders when selection is non-empty */}
        <BulkActionBar
          mode={selectAllMatching ? "all-matching" : "page"}
          selectedKeys={Array.from(bulkSelected)}
          totalMatching={total}
          // The "select all N matching" affordance only kicks in once the
          // visible page is fully checked.
          pageFullySelected={
            !selectAllMatching &&
            pageKeys.length > 0 &&
            selectedOnPage === pageKeys.length
          }
          filters={filters}
          onClear={clearBulk}
          onSwitchToAllMatching={() => {
            setSelectAllMatching(true);
            // Local set is irrelevant in this mode; clear it to avoid a
            // stale page-mode list lingering in memory.
            setBulkSelected(new Set());
          }}
          onAfterMutation={() => {
            clearBulk();
          }}
        />

        {/* Table */}
        <div className="flex-1 min-h-0 px-4 py-3 flex flex-col">
          <ContactsTable
            contacts={contacts}
            selectedKey={selectedKey}
            onSelect={(key) => setSelectedKey(key)}
            sortField={sortField}
            sortDir={sortDir}
            onSortChange={changeSort}
            loading={query.isFetching}
            bulkSelected={bulkSelected}
            headerSelection={headerSelection}
            onToggleRow={toggleRow}
            onToggleAllOnPage={toggleAllOnPage}
          />
        </div>

        {/* Pagination footer */}
        <footer className="shrink-0 px-4 h-10 flex items-center gap-2 border-t border-border/60 text-[12px]">
          <span className="text-muted-foreground">
            {total === 0
              ? "No contacts"
              : `${start}–${end} of ${total.toLocaleString()}`}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Per page</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => changePageSize(Number(v))}
              items={Object.fromEntries(
                PAGE_SIZE_OPTIONS.map((n) => [String(n), String(n)]),
              )}
            >
              <SelectTrigger size="sm" className="h-7 text-[11px] w-16">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="text-muted-foreground tabular-nums">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= totalPages || query.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </footer>
      </div>

      {/* Slide-out panel */}
      {selectedKey && (
        <ContactPanel
          contactKey={selectedKey}
          onClose={() => setSelectedKey(null)}
        />
      )}

      {/* Modals */}
      <CreateContactDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(key) => setSelectedKey(key)}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
