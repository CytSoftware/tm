"use client";

import { format } from "date-fns";
import { Building2, ListChecks } from "lucide-react";
import { useTheme } from "next-themes";

import type { MeetingEntityRef, MeetingSummary } from "@/hooks/use-meetings";
import {
  CATEGORY_META,
  categoryColor,
  formatDuration,
} from "@/lib/meeting-meta";
import { cn } from "@/lib/utils";

/** A person/company pill. Clicking it focuses the whole page on that entity. */
export function EntityChip({
  entity,
  onSelect,
  className,
}: {
  entity: Pick<MeetingEntityRef, "id" | "kind" | "name"> & { role?: string };
  onSelect?: (id: number) => void;
  className?: string;
}) {
  const body = (
    <>
      {entity.kind === "company" && <Building2 className="size-3 shrink-0" />}
      <span className="truncate">{entity.name}</span>
    </>
  );
  const cls = cn(
    "inline-flex max-w-40 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] leading-4",
    entity.kind === "company"
      ? "bg-muted text-foreground/80"
      : "text-muted-foreground",
    entity.role === "mentioned" && "border-dashed",
    className,
  );
  if (!onSelect) return <span className={cls}>{body}</span>;
  return (
    <button
      type="button"
      title={
        entity.role === "mentioned" ? `${entity.name} (mentioned)` : entity.name
      }
      onClick={(e) => {
        e.stopPropagation();
        onSelect(entity.id);
      }}
      className={cn(cls, "hover:border-foreground/40 hover:text-foreground")}
    >
      {body}
    </button>
  );
}

export function CategoryDot({
  category,
}: {
  category: MeetingSummary["category"];
}) {
  const dark = useTheme().resolvedTheme === "dark";
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ background: categoryColor(category, dark) }}
    />
  );
}

/** The backend cuts snippets out of raw markdown; drop the markup and
 *  emphasise the term that matched. */
function Snippet({ text, term }: { text: string; term: string }) {
  const clean = text.replace(/[*_`#>]+/g, "");
  const needle = term.trim().toLowerCase();
  const at = needle ? clean.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{clean}</>;
  return (
    <>
      {clean.slice(0, at)}
      <span className="font-medium not-italic text-foreground">
        {clean.slice(at, at + needle.length)}
      </span>
      {clean.slice(at + needle.length)}
    </>
  );
}

export function MeetingRow({
  meeting,
  selected,
  dateFormat = "d MMM",
  searchTerm = "",
  onOpen,
  onSelectEntity,
}: {
  meeting: MeetingSummary;
  selected: boolean;
  dateFormat?: string;
  /** The active search, so the snippet can show where it matched. */
  searchTerm?: string;
  onOpen: (key: string) => void;
  onSelectEntity: (id: number) => void;
}) {
  const started = new Date(meeting.started_at);
  // Attendees first, companies before people; mentions only fill leftover room.
  const chips = [...meeting.entities]
    .sort(
      (a, b) =>
        Number(a.role === "mentioned") - Number(b.role === "mentioned") ||
        Number(a.kind === "person") - Number(b.kind === "person"),
    )
    .slice(0, 4);
  const more = meeting.entities.length - chips.length;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(meeting.key)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(meeting.key);
      }}
      className={cn(
        "group flex cursor-pointer gap-3 border-b border-border/60 px-4 py-2.5 outline-none hover:bg-accent/40 focus-visible:bg-accent/60",
        selected && "bg-accent/60",
      )}
    >
      <div className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums leading-4 text-muted-foreground">
        <div>{format(started, dateFormat)}</div>
        <div className="text-muted-foreground/60">
          {format(started, "HH:mm")}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CategoryDot category={meeting.category} />
          <span className="truncate text-[13px] font-medium">
            {meeting.title}
          </span>
        </div>
        {(meeting.snippet || meeting.summary) && (
          <p
            className={cn(
              "mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground",
              meeting.snippet && "italic",
            )}
          >
            {meeting.snippet ? (
              <Snippet text={meeting.snippet} term={searchTerm} />
            ) : (
              meeting.summary
            )}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {chips.map((e) => (
            <EntityChip key={e.id} entity={e} onSelect={onSelectEntity} />
          ))}
          {more > 0 && (
            <span className="text-[11px] text-muted-foreground/70">
              +{more}
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 space-y-1 text-right text-[11px] leading-4 text-muted-foreground">
        <div>{CATEGORY_META[meeting.category]?.label}</div>
        <div className="tabular-nums text-muted-foreground/60">
          {formatDuration(meeting.duration_seconds)}
        </div>
        {meeting.open_action_item_count > 0 && (
          <div
            className="flex items-center justify-end gap-1"
            title={`${meeting.open_action_item_count} open action items`}
          >
            <ListChecks className="size-3" />
            {meeting.open_action_item_count}
          </div>
        )}
      </div>
    </div>
  );
}
