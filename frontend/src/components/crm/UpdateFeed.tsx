"use client";

/**
 * Updates as cards, grouped by day.
 *
 * Two orders, after the usual conventions: a lead's **thread** reads
 * oldest → newest with the composer below it (`chronological`, like an issue
 * or chat thread); the Activity tab and a contact's history are **feeds**,
 * newest first.
 *
 * Each card has three sections so context never mixes with content: a
 * tinted header (the lead, on the cross-lead feed; kind · their people … our
 * side · time · menu), the body (what was said), and a footer (the next step
 * it filed, the recording). Who typed it is in the time's tooltip.
 */

import { Fragment, useState } from "react";
import { format, isThisYear, isToday, isYesterday } from "date-fns";
import { AudioLines, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/UserAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Update, useDeleteUpdate, useEditUpdate } from "@/hooks/use-crm";
import {
  companyDomain,
  dayOf,
  errorMessage,
  updateKindMeta,
  userLabel,
} from "@/lib/crm-meta";

import { StepRow } from "./StepRow";
import { CompanyMark } from "./shared";

export function UpdateFeed({
  updates,
  chronological,
  showLead,
  onOpenContact,
  onOpenLead,
  empty,
}: {
  /** Newest first, as the API returns them. */
  updates: Update[];
  /** Oldest first — a thread rather than a feed. */
  chronological?: boolean;
  /** Name the lead on each entry (the cross-lead feed). */
  showLead?: boolean;
  onOpenContact?: (id: number) => void;
  onOpenLead?: (key: string) => void;
  empty?: React.ReactNode;
}) {
  if (updates.length === 0) {
    return (
      <p className="px-4 py-3 text-[12px] text-muted-foreground">
        {empty ?? "No updates yet."}
      </p>
    );
  }
  const items = chronological ? [...updates].reverse() : updates;
  const days = items.map((u) => dayOf(u.occurred_at));
  return (
    <ol className="space-y-2.5 px-4 pb-3">
      {items.map((u, i) => (
        <Fragment key={u.id}>
          {(i === 0 || days[i] !== days[i - 1]) && (
            <li className="flex items-center gap-2 pt-2 text-[11px] font-medium text-muted-foreground">
              {dayLabel(u.occurred_at)}
              <span className="h-px flex-1 bg-border/70" />
            </li>
          )}
          <Entry
            update={u}
            showLead={showLead}
            onOpenContact={onOpenContact}
            onOpenLead={onOpenLead}
          />
        </Fragment>
      ))}
    </ol>
  );
}

function Entry({
  update: u,
  showLead,
  onOpenContact,
  onOpenLead,
}: {
  update: Update;
  showLead?: boolean;
  onOpenContact?: (id: number) => void;
  onOpenLead?: (key: string) => void;
}) {
  const edit = useEditUpdate();
  const del = useDeleteUpdate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const kind = updateKindMeta(u.kind);
  const leadCompany = u.lead?.company?.name ?? null;
  const author = u.created_by ? userLabel(u.created_by) : "an agent";

  const save = () => {
    const body = draft.trim();
    if (!body || body === u.body) return setEditing(false);
    edit.mutate(
      { id: u.id, body },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  // Time + menu, top-right of the header whichever line that is.
  const meta = (
    <>
      <span
        className="tabular-nums text-[11px] text-muted-foreground"
        title={`${new Date(u.occurred_at).toLocaleString()} · posted by ${author}`}
      >
        {format(new Date(u.occurred_at), "HH:mm")}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Update options"
              className="tap-target -mr-1 grid size-5 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 hover-none:opacity-100 data-[popup-open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={() => {
              setDraft(u.body);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              if (
                !window.confirm(
                  "Delete this update? Its next step stays as a task.",
                )
              )
                return;
              del.mutate(u.id, {
                onError: (e) => toast.error(errorMessage(e)),
              });
            }}
          >
            <Trash2 className="size-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <li className="group overflow-hidden rounded-lg border border-border bg-background">
      {/* Header — context and who: never mixed into the body. */}
      <header className="space-y-0.5 border-b border-border/70 bg-muted/40 px-3 py-2">
        {showLead && u.lead && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenLead?.(u.lead!.key)}
              className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium hover:underline"
            >
              {u.lead.company && (
                <CompanyMark domain={companyDomain(u.lead.company.website)} />
              )}
              <span className="truncate">
                {leadCompany ? `${leadCompany} · ` : ""}
                {u.lead.title}
              </span>
            </button>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {meta}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <kind.icon className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium text-foreground">
            {kind.label}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {u.people.map((p, i) => (
              <span key={p.id}>
                {i === 0 ? "with " : ", "}
                <button
                  type="button"
                  onClick={() => onOpenContact?.(p.id)}
                  title={
                    [p.position, p.company].filter(Boolean).join(" · ") ||
                    undefined
                  }
                  className="text-foreground hover:underline"
                >
                  {p.name}
                </button>
                {p.company && p.company !== leadCompany && ` (${p.company})`}
              </span>
            ))}
          </span>
          {u.users.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-1"
              title={`Our side: ${u.users.map(userLabel).join(", ")}`}
            >
              <span className="text-[11px] max-sm:hidden">Our side</span>
              <span className="flex -space-x-1">
                {u.users.map((x) => (
                  <UserAvatar
                    key={x.id}
                    username={x.username}
                    avatarUrl={x.avatar_url}
                    size="size-4"
                  />
                ))}
              </span>
            </span>
          )}
          {!(showLead && u.lead) && (
            <span className="flex shrink-0 items-center gap-1">{meta}</span>
          )}
        </div>
      </header>

      {/* Body — what was said. */}
      <div className="px-3 py-2.5">
        {editing ? (
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
                disabled={edit.isPending}
                className="h-6 rounded bg-foreground px-2 text-[12px] font-medium text-background disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p
            className="whitespace-pre-wrap text-[13px] leading-relaxed"
            dir="auto"
          >
            {u.body}
          </p>
        )}
      </div>

      {/* Footer — what it led to: the next step it filed, the recording. */}
      {(u.task || u.meeting) && (
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-3 py-2">
          {u.task && (
            <StepRow
              step={u.task}
              label="Next"
              className="min-w-0 max-w-full"
            />
          )}
          {u.meeting && (
            <a
              href={`/meetings?m=${u.meeting.key}`}
              className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              <AudioLines className="size-3.5 shrink-0" />
              <span className="truncate">{u.meeting.title}</span>
              {u.meeting.duration_seconds != null && (
                <span className="shrink-0 tabular-nums">
                  · {Math.max(1, Math.round(u.meeting.duration_seconds / 60))}m
                </span>
              )}
            </a>
          )}
        </footer>
      )}
    </li>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, isThisYear(d) ? "EEE, MMM d" : "EEE, MMM d, yyyy");
}
