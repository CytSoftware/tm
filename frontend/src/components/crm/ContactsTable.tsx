"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CONTACT_SORT_LABELS,
  type Contact,
  type ContactSortField,
} from "@/lib/types";
import { countryName } from "@/lib/countries";
import { cn } from "@/lib/utils";

/** Header tri-state for the page-level "select all" checkbox.
 *  ``none`` = nothing selected on this page,
 *  ``some`` = some-but-not-all selected (renders as indeterminate),
 *  ``all``  = every visible row is selected. */
export type HeaderSelectionState = "none" | "some" | "all";

type Props = {
  contacts: Contact[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  sortField: ContactSortField | null;
  sortDir: "asc" | "desc" | null;
  onSortChange: (
    field: ContactSortField,
    dir: "asc" | "desc",
  ) => void;
  loading?: boolean;
  // Bulk-selection wiring (kept on this component because the checkbox cell
  // shares row geometry with the rest of the cells).
  bulkSelected: Set<string>;
  headerSelection: HeaderSelectionState;
  onToggleRow: (key: string) => void;
  onToggleAllOnPage: () => void;
};

const COLUMNS: {
  field: ContactSortField | null;
  header: string;
  cell: (c: Contact) => React.ReactNode;
  className?: string;
}[] = [
  {
    field: "key",
    header: "Key",
    cell: (c) => (
      <span className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase">
        {c.key}
      </span>
    ),
    className: "w-24",
  },
  {
    field: "first_name",
    header: "Name",
    cell: (c) => {
      const full = `${c.first_name} ${c.last_name}`.trim();
      return full ? (
        <span className="font-medium">{full}</span>
      ) : (
        <span className="text-muted-foreground italic">—</span>
      );
    },
  },
  {
    field: "company",
    header: "Company",
    cell: (c) =>
      c.company ? (
        c.company
      ) : (
        <span className="text-muted-foreground italic">—</span>
      ),
  },
  {
    field: "job_title",
    header: "Title",
    cell: (c) =>
      c.job_title ? (
        c.job_title
      ) : (
        <span className="text-muted-foreground italic">—</span>
      ),
  },
  {
    field: "industry",
    header: "Industry",
    cell: (c) =>
      c.industry ? (
        c.industry
      ) : (
        <span className="text-muted-foreground italic">—</span>
      ),
  },
  {
    field: "email",
    header: "Email",
    cell: (c) =>
      c.email ? (
        <a
          href={`mailto:${c.email}`}
          onClick={(e) => e.stopPropagation()}
          className="text-primary hover:underline"
        >
          {c.email}
        </a>
      ) : (
        <span className="text-muted-foreground italic">—</span>
      ),
  },
  {
    field: null,
    header: "Phone",
    cell: (c) =>
      c.phone || <span className="text-muted-foreground italic">—</span>,
  },
  {
    field: "country",
    header: "Country",
    cell: (c) =>
      c.country ? (
        <span title={countryName(c.country)}>
          <span className="font-mono text-[10px] mr-1.5 text-muted-foreground">
            {c.country}
          </span>
          {countryName(c.country)}
        </span>
      ) : (
        <span className="text-muted-foreground italic">—</span>
      ),
  },
  {
    field: "city",
    header: "City",
    cell: (c) =>
      c.city || <span className="text-muted-foreground italic">—</span>,
  },
  {
    field: null,
    header: "Labels",
    cell: (c) => (
      <div className="flex gap-1 flex-wrap">
        {c.labels.length === 0 && (
          <span className="text-muted-foreground italic">—</span>
        )}
        {c.labels.map((l) => (
          <Badge
            key={l.id}
            variant="secondary"
            className="text-[10px] h-4 px-1.5"
            style={{
              backgroundColor: `${l.color}22`,
              color: l.color,
              border: `1px solid ${l.color}44`,
            }}
          >
            {l.name}
          </Badge>
        ))}
      </div>
    ),
  },
];

export function ContactsTable({
  contacts,
  selectedKey,
  onSelect,
  sortField,
  sortDir,
  onSortChange,
  loading,
  bulkSelected,
  headerSelection,
  onToggleRow,
  onToggleAllOnPage,
}: Props) {
  function handleSortClick(field: ContactSortField | null) {
    if (!field) return;
    if (sortField !== field) {
      onSortChange(field, "asc");
      return;
    }
    onSortChange(field, sortDir === "asc" ? "desc" : "asc");
  }

  // Total cell count incl. the leading checkbox column — used for the
  // "no rows" / "loading" colSpan.
  const totalCols = COLUMNS.length + 1;

  return (
    <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border/60 bg-background">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-muted/40 backdrop-blur">
          <TableRow>
            <TableHead className="w-10 px-2">
              <CheckboxCell
                checked={headerSelection === "all"}
                indeterminate={headerSelection === "some"}
                onToggle={onToggleAllOnPage}
                ariaLabel="Select all rows on this page"
              />
            </TableHead>
            {COLUMNS.map((col) => (
              <TableHead
                key={col.header}
                className={cn(col.className, col.field && "cursor-pointer select-none")}
                onClick={() => handleSortClick(col.field)}
              >
                <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  {col.field
                    ? CONTACT_SORT_LABELS[col.field as ContactSortField]
                    : col.header}
                  {col.field && sortField === col.field ? (
                    sortDir === "desc" ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUp className="size-3" />
                    )
                  ) : col.field ? (
                    <ArrowUpDown className="size-3 opacity-30" />
                  ) : null}
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && contacts.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={totalCols}
                className="text-center text-muted-foreground py-12"
              >
                Loading…
              </TableCell>
            </TableRow>
          )}
          {!loading && contacts.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={totalCols}
                className="text-center text-muted-foreground py-12"
              >
                No contacts match the current filters.
              </TableCell>
            </TableRow>
          )}
          {contacts.map((c) => {
            const checked = bulkSelected.has(c.key);
            return (
              <TableRow
                key={c.id}
                className={cn(
                  "cursor-pointer",
                  selectedKey === c.key && "bg-muted/60",
                  checked && "bg-primary/5",
                )}
                onClick={() => onSelect(c.key)}
                data-state={checked ? "selected" : undefined}
              >
                <TableCell className="w-10 px-2">
                  <CheckboxCell
                    checked={checked}
                    onToggle={() => onToggleRow(c.key)}
                    ariaLabel={`Select ${c.key}`}
                  />
                </TableCell>
                {COLUMNS.map((col) => (
                  <TableCell key={col.header} className="text-[13px]">
                    {col.cell(c)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function CheckboxCell({
  checked,
  indeterminate,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <span
      role="presentation"
      // Stop the click from bubbling to the row, which opens the slide-out
      // panel. Selection and panel-open are different gestures.
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex items-center justify-center cursor-pointer p-1"
    >
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        aria-label={ariaLabel}
      />
    </span>
  );
}
