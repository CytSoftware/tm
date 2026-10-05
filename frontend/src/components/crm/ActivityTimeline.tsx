"use client";

/**
 * A vertical history of meetings, touchpoints/notes and closed follow-ups.
 *
 * Used for one contact (the detail pane) and for the whole CRM (the Activity
 * tab, `showPeople`). Touchpoints are the only items edited here — meetings
 * belong to /meetings and follow-ups are tasks — so they get inline edit and
 * delete, which is what keeps a contact's notes current rather than append-only.
 */

import { Fragment, useState } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { ArrowUpRight, AudioLines, CheckCircle2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  type TimelineItem,
  useDeleteTouchpoint,
  useUpdateTouchpoint,
} from "@/hooks/use-crm";
import { TOUCHPOINT_META, errorMessage, shortDate } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

export function ActivityTimeline({
  items,
  showPeople,
  groupByDay,
  onOpenContact,
  empty,
}: {
  items: TimelineItem[];
  /** Name the contacts on each item (the cross-contact feed). */
  showPeople?: boolean;
  groupByDay?: boolean;
  onOpenContact?: (id: number) => void;
  empty?: React.ReactNode;
}) {
  if (items.length === 0) {
    return (
      <p className="px-4 text-[12px] text-muted-foreground">
        {empty ??
          "Nothing yet. Recorded meetings, logged touches, notes and closed follow-ups show up here."}
      </p>
    );
  }
  // Precompute day headers (no mutation during render).
  const headers = items.map((item, i) => {
    if (!groupByDay) return null;
    const day = format(new Date(item.at), "yyyy-MM-dd");
    const prev = i > 0 ? format(new Date(items[i - 1].at), "yyyy-MM-dd") : "";
    return day !== prev ? dayLabel(item.at) : null;
  });
  return (
    <ol className="relative mx-4 mt-1 border-l border-border/70">
      {items.map((item, i) => (
        <Fragment key={itemKey(item)}>
          {headers[i] && (
            <li className="-ml-px pb-1 pl-4 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground first:pt-1">
              {headers[i]}
            </li>
          )}
          <Row
            item={item}
            showPeople={showPeople}
            showDate={!groupByDay}
            onOpenContact={onOpenContact}
          />
        </Fragment>
      ))}
    </ol>
  );
}

function Row({
  item,
  showPeople,
  showDate,
  onOpenContact,
}: {
  item: TimelineItem;
  showPeople?: boolean;
  showDate?: boolean;
  onOpenContact?: (id: number) => void;
}) {
  const update = useUpdateTouchpoint();
  const del = useDeleteTouchpoint();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const save = () => {
    if (item.type !== "touchpoint") return;
    const summary = draft.trim();
    if (!summary || summary === item.summary) return setEditing(false);
    update.mutate(
      { id: item.id, summary },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <li className="group relative py-2 pl-4">
      <span className="absolute -left-[9px] top-2.5 grid size-[17px] place-items-center rounded-full border border-border bg-background">
        <Icon item={item} />
      </span>
      <div className="flex items-baseline gap-2">
        <span
          className="text-[11px] tabular-nums text-muted-foreground"
          title={new Date(item.at).toLocaleString()}
        >
          {showDate ? shortDate(item.at) : format(new Date(item.at), "HH:mm")}
        </span>
        <span className="text-[11px] text-muted-foreground/70">{label(item)}</span>
        {item.type === "touchpoint" && !editing && (
          <span className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 hover-none:opacity-100">
            <button
              type="button"
              aria-label="Edit"
              onClick={() => {
                setDraft(item.summary);
                setEditing(true);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              aria-label="Delete"
              onClick={() => {
                if (!window.confirm("Delete this entry?")) return;
                del.mutate(item.id, { onError: (e) => toast.error(errorMessage(e)) });
              }}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </div>

      {item.type === "meeting" ? (
        <a
          href={`/meetings?m=${item.key}`}
          className="mt-0.5 block text-[13px] font-medium hover:underline"
        >
          {item.title}
          <ArrowUpRight className="ml-0.5 inline size-3 text-muted-foreground" />
        </a>
      ) : item.type === "follow_up" ? (
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          <span className={cn(item.status === "cancelled" && "line-through")}>{item.title}</span>
          <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/60">{item.key}</span>
        </p>
      ) : editing ? (
        <div className="mt-1">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            }}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            className="block w-full resize-y rounded-md border border-ring bg-transparent px-2 py-1.5 text-[13px] outline-none"
            dir="auto"
          />
          <div className="mt-1 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="h-6 rounded px-2 text-[12px] text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={update.isPending}
              className="h-6 rounded bg-foreground px-2 text-[12px] font-medium text-background disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap text-[13px]" dir="auto">
          {item.summary}
        </p>
      )}

      {item.type === "meeting" && item.summary && item.summary !== item.title && (
        <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{item.summary}</p>
      )}
      {(showPeople ? item.entities.length > 0 : item.type !== "follow_up" && item.entities.length > 1) && (
        <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[11px] text-muted-foreground/80">
          {!showPeople && <span>with</span>}
          {item.entities.map((e, i) =>
            onOpenContact ? (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpenContact(e.id)}
                className="hover:text-foreground hover:underline"
              >
                {e.name}
                {i < item.entities.length - 1 ? "," : ""}
              </button>
            ) : (
              <span key={e.id}>
                {e.name}
                {i < item.entities.length - 1 ? "," : ""}
              </span>
            ),
          )}
        </p>
      )}
    </li>
  );
}

function itemKey(item: TimelineItem): string {
  if (item.type === "touchpoint") return `t${item.id}`;
  return `${item.type}-${item.key}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, MMM d");
}

function Icon({ item }: { item: TimelineItem }) {
  const cls = "size-2.5 text-muted-foreground";
  if (item.type === "meeting") return <AudioLines className={cls} />;
  if (item.type === "follow_up") return <CheckCircle2 className={cls} />;
  const I = TOUCHPOINT_META[item.kind]?.icon ?? Pencil;
  return <I className={cls} />;
}

function label(item: TimelineItem): string {
  if (item.type === "meeting") return "Meeting";
  if (item.type === "follow_up")
    return item.status === "cancelled" ? "Follow-up dropped" : "Follow-up done";
  const meta = TOUCHPOINT_META[item.kind];
  const dir = item.direction === "in" ? " · inbound" : item.direction === "out" ? " · outbound" : "";
  const via = item.source !== "manual" ? ` · via ${item.source}` : "";
  const who = item.created_by ? ` · ${item.created_by}` : "";
  return `${meta?.label ?? item.kind}${dir}${via}${who}`;
}
