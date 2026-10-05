"use client";

/**
 * The CRM home: what we owe whom, by when.
 *
 * Open follow-ups (tasks in the CRM project) bucketed Overdue / Today / This
 * week / Later in the browser's timezone, then the contacts with no next step
 * — in the CRM but nothing scheduled, which is how a lead goes cold silently.
 */

import { useState } from "react";
import { Check, Clock, Plus } from "lucide-react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/UserAvatar";
import {
  type Contact,
  type FollowUp,
  useCreateFollowUp,
  useCrmInbox,
  useFollowUpAction,
} from "@/hooks/use-crm";
import { dayOf, errorMessage, isoDay, relativeDay, shortDate } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

import {
  Empty,
  KindIcon,
  RelationshipPill,
  SectionHeader,
  ghostBtnCls,
  inputCls,
} from "./shared";

const BUCKETS = [
  { id: "overdue", title: "Overdue", tone: "danger" as const },
  { id: "today", title: "Today" },
  { id: "week", title: "Next 7 days" },
  { id: "later", title: "Later" },
] as const;

export function InboxView({
  owner,
  onOpenContact,
}: {
  owner: string;
  onOpenContact: (id: number) => void;
}) {
  const inbox = useCrmInbox(owner);

  if (inbox.isLoading) return <Empty>Loading…</Empty>;
  if (inbox.isError) return <Empty tone="error">Couldn’t load the inbox.</Empty>;
  const data = inbox.data!;
  const total = BUCKETS.reduce((n, b) => n + data.buckets[b.id].length, 0);

  return (
    <div className="h-full min-h-0 overflow-y-auto pb-10">
      {total === 0 && (
        <p className="px-4 pt-6 text-[13px] text-muted-foreground">
          Nothing owed right now. Log a touch on a contact, or ask Claude —
          “remind me to call Ramzi Thursday” — and it lands here.
        </p>
      )}
      {BUCKETS.map((b) =>
        data.buckets[b.id].length === 0 ? null : (
          <section key={b.id}>
            <SectionHeader
              title={b.title}
              count={data.buckets[b.id].length}
              tone={"tone" in b ? b.tone : undefined}
            />
            <ul className="divide-y divide-border/60 border-y border-border/60">
              {data.buckets[b.id].map((f) => (
                <FollowUpRow
                  key={f.id}
                  followUp={f}
                  overdue={b.id === "overdue"}
                  onOpenContact={onOpenContact}
                />
              ))}
            </ul>
          </section>
        ),
      )}

      {data.no_next_step.length > 0 && (
        <section>
          <SectionHeader title="No next step" count={data.no_next_step.length} />
          <p className="px-4 pb-2 text-[12px] text-muted-foreground">
            In the CRM, nothing scheduled. Add a follow-up or let them go.
          </p>
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {data.no_next_step.map((c) => (
              <NoNextStepRow key={c.id} contact={c} onOpenContact={onOpenContact} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function FollowUpRow({
  followUp: f,
  overdue,
  onOpenContact,
  compact,
}: {
  followUp: FollowUp;
  overdue?: boolean;
  onOpenContact?: (id: number) => void;
  compact?: boolean;
}) {
  const act = useFollowUpAction();
  const [picking, setPicking] = useState(false);
  const run = (vars: Parameters<typeof act.mutate>[0], msg: string) =>
    act.mutate(vars, {
      onSuccess: () => toast.success(msg),
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <li className="group flex items-center gap-2 px-4 py-2 hover:bg-accent/30">
      <button
        type="button"
        aria-label={f.is_open ? "Mark done" : "Reopen"}
        title={f.is_open ? "Mark done" : "Reopen"}
        disabled={act.isPending}
        onClick={() =>
          run(
            { id: f.id, action: f.is_open ? "complete" : "reopen" },
            f.is_open ? `Done — ${f.task_key}` : "Reopened",
          )
        }
        className={cn(
          "tap-target grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/50 hover:border-foreground",
          !f.is_open && "border-foreground bg-foreground text-background",
        )}
      >
        <Check className={cn("size-2.5", f.is_open && "opacity-0 group-hover:opacity-40 hover-none:opacity-40")} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("truncate text-[13px]", !f.is_open && "text-muted-foreground line-through")}>
            {f.title}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
            {f.task_key}
          </span>
        </div>
        {!compact && (
          <div className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
            <button
              type="button"
              onClick={() => onOpenContact?.(f.entity.id)}
              className="truncate hover:text-foreground hover:underline"
            >
              {f.entity.name}
            </button>
            {f.company && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <button
                  type="button"
                  onClick={() => onOpenContact?.(f.company!.id)}
                  className="truncate hover:text-foreground hover:underline"
                >
                  {f.company.name}
                </button>
              </>
            )}
            {f.deal && (
              <span className="truncate text-muted-foreground/70">· {f.deal.title}</span>
            )}
          </div>
        )}
      </div>

      <span
        title={f.due_at ? new Date(f.due_at).toLocaleString() : "No due date"}
        className={cn(
          "shrink-0 text-[12px] tabular-nums text-muted-foreground",
          overdue && "text-destructive",
        )}
      >
        {f.due_at ? relativeDay(f.due_at) : "no date"}
      </span>

      {f.is_open &&
        (picking ? (
          <input
            type="date"
            autoFocus
            defaultValue={dayOf(f.due_at)}
            onBlur={() => setPicking(false)}
            onChange={(e) => {
              if (!e.target.value) return;
              setPicking(false);
              run({ id: f.id, action: "reschedule", due: e.target.value }, `Moved to ${shortDate(e.target.value)}`);
            }}
            className="h-7 shrink-0 rounded-md border border-border bg-transparent px-1 text-[12px]"
          />
        ) : (
          <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover-none:opacity-100">
            <button
              type="button"
              className={ghostBtnCls}
              title="Snooze a day"
              onClick={() => run({ id: f.id, action: "reschedule", due: isoDay(1) }, "Snoozed to tomorrow")}
            >
              +1d
            </button>
            <button
              type="button"
              className={cn(ghostBtnCls, "max-lg:hidden")}
              title="Snooze a week"
              onClick={() => run({ id: f.id, action: "reschedule", due: isoDay(7) }, "Snoozed a week")}
            >
              +1w
            </button>
            <button
              type="button"
              className={ghostBtnCls}
              title="Pick a date"
              aria-label="Pick a date"
              onClick={() => setPicking(true)}
            >
              <Clock className="size-3.5" />
            </button>
          </div>
        ))}

      {f.assignees[0] && !compact && (
        <UserAvatar
          username={f.assignees[0].username}
          avatarUrl={f.assignees[0].avatar_url}
          size="size-5"
          className="max-lg:hidden"
        />
      )}
    </li>
  );
}

function NoNextStepRow({
  contact: c,
  onOpenContact,
}: {
  contact: Contact;
  onOpenContact: (id: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <li className="px-4 py-2 hover:bg-accent/30">
      <div className="flex items-center gap-2">
        <KindIcon kind={c.kind} />
        <button
          type="button"
          onClick={() => onOpenContact(c.id)}
          className="min-w-0 truncate text-[13px] hover:underline"
        >
          {c.name}
        </button>
        {c.company && (
          <span className="truncate text-[12px] text-muted-foreground">{c.company.name}</span>
        )}
        <RelationshipPill relationship={c.relationship} />
        <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
          {c.last_contact_at ? `last ${relativeDay(c.last_contact_at)}` : "never contacted"}
        </span>
        {!adding && (
          <button type="button" className={ghostBtnCls} onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            <span className="max-lg:hidden">Follow-up</span>
          </button>
        )}
      </div>
      {adding && (
        <QuickFollowUp
          entityId={c.id}
          placeholder={`What do we owe ${c.name}?`}
          onDone={() => setAdding(false)}
        />
      )}
    </li>
  );
}

/** One-line "title · date · add" form, used in the inbox and contact pane. */
export function QuickFollowUp({
  entityId,
  dealKey,
  placeholder,
  onDone,
}: {
  entityId: number;
  dealKey?: string;
  placeholder?: string;
  onDone?: () => void;
}) {
  const create = useCreateFollowUp();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(isoDay(1));
  const submit = () => {
    if (!title.trim()) return;
    create.mutate(
      { entity: entityId, title: title.trim(), due: due || null, deal: dealKey ?? null },
      {
        onSuccess: (f) => {
          toast.success(`Follow-up ${f.task_key} added`);
          setTitle("");
          onDone?.();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };
  return (
    <form
      className="mt-2 flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone?.()}
        placeholder={placeholder ?? "Follow-up…"}
        className={cn(inputCls, "h-7 flex-1 text-[12px]")}
      />
      <input
        type="date"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        className="h-7 shrink-0 rounded-md border border-border bg-transparent px-1 text-[12px]"
      />
      <button
        type="submit"
        disabled={!title.trim() || create.isPending}
        className="tap-target h-7 shrink-0 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background disabled:opacity-40"
      >
        Add
      </button>
    </form>
  );
}
