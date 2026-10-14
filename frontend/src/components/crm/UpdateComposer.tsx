"use client";

/**
 * Post an update. Collapsed it's one line ("Post an update…"); focused it
 * opens into: kind + date, the text, who it was with (their side and ours,
 * each through a picker; ours defaults to you), and what they need next —
 * filed as a task in the lead's project, linked to this update.
 */

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, CircleDashed, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/UserAvatar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type EntityRef,
  type UpdateKind,
  useContacts,
  useCreateContact,
  usePostUpdate,
} from "@/hooks/use-crm";
import { useUsersQuery } from "@/hooks/use-users";
import { fetchMe } from "@/lib/auth";
import { UPDATE_KINDS, errorMessage, isoDay, userLabel } from "@/lib/crm-meta";
import { meKey } from "@/lib/query-keys";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

const fieldCls =
  "h-7 shrink-0 rounded-md border border-border bg-transparent px-1.5 text-[12px] outline-none focus-visible:border-ring";

export function UpdateComposer({
  lead,
  company,
  suggested = [],
  preselect,
  canFile = false,
  placeholder = "What happened?",
}: {
  /** Lead key the update goes on; absent = an update that only tags people. */
  lead?: string;
  /** Their company — its people are offered in the picker. */
  company?: EntityRef | null;
  /** People to offer. */
  suggested?: EntityRef[];
  /** Ids tagged from the start (and after each post). */
  preselect?: number[];
  /** The lead has a project, so "what they need next" can be filed. */
  canFile?: boolean;
  placeholder?: string;
}) {
  const post = usePostUpdate();
  const { data: me } = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const users = useUsersQuery();
  const textRef = useRef<HTMLTextAreaElement>(null);

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<UpdateKind>("note");
  const [body, setBody] = useState("");
  const initialPeople = () => preselect ?? [];
  const [people, setPeople] = useState<number[]>(initialPeople);
  const [known, setKnown] = useState<EntityRef[]>([]);
  /** `null` = the default, which is just you. */
  const [team, setTeam] = useState<number[] | null>(null);
  const [day, setDay] = useState(isoDay(0));
  const [step, setStep] = useState("");
  const [due, setDue] = useState("");
  /** "" = the default, which is you. */
  const [assignee, setAssignee] = useState("");

  const ourSide = team ?? (me ? [me.id] : []);
  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const reset = () => {
    setBody("");
    setKind("note");
    setStep("");
    setDue("");
    setAssignee("");
    setDay(isoDay(0));
    setTeam(null);
    setPeople(initialPeople());
    setOpen(false);
  };

  const submit = () => {
    if (!body.trim()) return;
    // A past day is logged at midday local time; today means now.
    const occurred_at =
      day && day !== isoDay(0)
        ? new Date(`${day}T12:00`).toISOString()
        : undefined;
    post.mutate(
      {
        kind,
        body: body.trim(),
        lead: lead ?? null,
        people,
        ...(team ? { users: team } : {}),
        occurred_at,
        ...(canFile && step.trim()
          ? {
              next_step: step.trim(),
              next_due: due || null,
              next_assignee: assignee ? Number(assignee) : null,
            }
          : {}),
      },
      { onSuccess: reset, onError: (e) => toast.error(errorMessage(e)) },
    );
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => textRef.current?.focus());
        }}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-border px-3 text-left text-[13px] text-muted-foreground hover:border-foreground/30"
      >
        <Plus className="size-3.5" />
        Post an update…
      </button>
    );
  }

  const selected = [...suggested, ...known].filter(
    (p, i, all) =>
      people.includes(p.id) && all.findIndex((q) => q.id === p.id) === i,
  );

  return (
    <form
      className="rounded-lg border border-ring bg-background"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !body.trim()) reset();
      }}
    >
      <div className="flex items-center gap-0.5 overflow-x-auto px-1.5 pt-1.5">
        {UPDATE_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            aria-pressed={kind === k.id}
            onClick={() => setKind(k.id)}
            className={cn(
              "tap-target inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[12px] text-muted-foreground hover:text-foreground",
              kind === k.id && "bg-accent text-foreground",
            )}
          >
            <k.icon className="size-3" />
            {k.label}
          </button>
        ))}
        <input
          type="date"
          aria-label="When"
          value={day}
          max={isoDay(0)}
          onChange={(e) => setDay(e.target.value)}
          className="ml-auto h-6 shrink-0 bg-transparent px-1 text-[12px] text-muted-foreground outline-none"
        />
      </div>

      <textarea
        ref={textRef}
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={3}
        placeholder={placeholder}
        className="block w-full resize-none bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/60"
        dir="auto"
      />

      {/* Who: their side (picker) · our side (avatar toggles) */}
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2 text-[12px]">
        {selected.map((p) => (
          <span
            key={p.id}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-accent pl-2 pr-1"
          >
            {p.name}
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={() => setPeople((x) => x.filter((id) => id !== p.id))}
              className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <PeoplePicker
          company={company}
          suggested={suggested}
          selected={people}
          onToggle={(p) => {
            setKnown((x) => (x.some((q) => q.id === p.id) ? x : [...x, p]));
            setPeople((x) => toggle(x, p.id));
          }}
        />
        <OurSidePicker
          users={users.data ?? []}
          meId={me?.id}
          selected={ourSide}
          onToggle={(id) => setTeam(toggle(ourSide, id))}
        />
      </div>

      {canFile && (
        <div className="flex items-center gap-1.5 border-t border-border/70 px-3 py-1.5">
          <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={step}
            onChange={(e) => setStep(e.target.value)}
            placeholder="What they need next (optional) — becomes a task"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
            dir="auto"
          />
          {step.trim() && (
            <>
              <input
                type="date"
                aria-label="Due"
                value={due}
                min={isoDay(0)}
                onChange={(e) => setDue(e.target.value)}
                className={fieldCls}
              />
              <select
                aria-label="Assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className={cn(fieldCls, "max-w-28")}
              >
                <option value="">Me</option>
                {(users.data ?? [])
                  .filter((u) => u.id !== me?.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {userLabel(u)}
                    </option>
                  ))}
              </select>
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-1 border-t border-border/70 px-2 py-1.5">
        {lead && !canFile && (
          <span className="truncate text-[11px] text-muted-foreground">
            Set the lead’s project to file what they need next.
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground/60 max-lg:hidden">
          ⌘↵
        </span>
        <button
          type="button"
          onClick={reset}
          className="tap-target h-7 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!body.trim() || post.isPending}
          className="tap-target h-7 rounded-md bg-foreground px-3 text-[12px] font-medium text-background disabled:opacity-40"
        >
          Post
        </button>
      </div>
    </form>
  );
}

/** "Our side ▾": who from us was on it — a checklist menu, you first. The
 *  trigger shows the picked avatars and names, so the default (you) reads
 *  at a glance. */
function OurSidePicker({
  users,
  meId,
  selected,
  onToggle,
}: {
  users: User[];
  meId?: number;
  selected: number[];
  onToggle: (id: number) => void;
}) {
  const ordered = [...users].sort(
    (a, b) => Number(b.id === meId) - Number(a.id === meId),
  );
  const picked = ordered.filter((u) => selected.includes(u.id));
  const name = (u: User) =>
    u.id === meId ? "You" : u.first_name || u.username;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="tap-target ml-auto inline-flex h-6 max-w-52 items-center gap-1.5 rounded-full border border-border pl-1 pr-1.5 text-muted-foreground hover:text-foreground"
          >
            {picked.length > 0 ? (
              <span className="flex shrink-0 -space-x-1">
                {picked.map((u) => (
                  <UserAvatar
                    key={u.id}
                    username={u.username}
                    avatarUrl={u.avatar_url}
                    size="size-4"
                  />
                ))}
              </span>
            ) : (
              <span className="pl-1">Our side</span>
            )}
            <span className="truncate text-foreground">
              {picked.map(name).join(", ")}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Our side</DropdownMenuLabel>
          {ordered.map((u) => (
            <DropdownMenuCheckboxItem
              key={u.id}
              checked={selected.includes(u.id)}
              onCheckedChange={() => onToggle(u.id)}
              closeOnClick={false}
            >
              <UserAvatar
                username={u.username}
                avatarUrl={u.avatar_url}
                size="size-4"
              />
              {u.id === meId ? `${userLabel(u)} (you)` : userLabel(u)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "+ With…": the company's people (and any suggested) as a checklist, plus
 *  a name field that finds-or-creates someone (at the company, if known). */
function PeoplePicker({
  company,
  suggested,
  selected,
  onToggle,
}: {
  company?: EntityRef | null;
  suggested: EntityRef[];
  selected: number[];
  onToggle: (p: EntityRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const colleagues = useContacts(
    {
      kind: "person",
      company: company ? String(company.id) : undefined,
      all: "1",
    },
    open && !!company,
  );
  const search = useContacts(
    { kind: "person", search: name.trim() },
    open && name.trim().length > 1,
  );
  const create = useCreateContact();

  const options = useMemo(() => {
    const seen = new Set<number>();
    const pool =
      name.trim().length > 1
        ? (search.data ?? [])
        : [...suggested, ...(colleagues.data ?? [])];
    return pool.filter((p) =>
      seen.has(p.id) ? false : (seen.add(p.id), true),
    );
  }, [name, search.data, suggested, colleagues.data]);

  const add = () => {
    const n = name.trim();
    if (!n) return;
    create.mutate(
      {
        kind: "person",
        name: n,
        ...(company ? { company: company.name } : {}),
      },
      {
        onSuccess: (p) => {
          onToggle({ id: p.id, kind: "person", name: p.name });
          setName("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="tap-target inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3" />
            {selected.length ? "Add" : "With…"}
          </button>
        }
      />
      <PopoverContent align="start" className="w-64 p-1">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const exact = options.find(
                (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
              );
              if (exact) onToggle(exact);
              else add();
            }
          }}
          placeholder={
            company
              ? `Search, or add someone at ${company.name}`
              : "Search or add a person"
          }
          className="mb-1 h-8 w-full rounded-md border border-border bg-transparent px-2 text-[12px] outline-none focus-visible:border-ring"
        />
        <div className="max-h-56 overflow-y-auto">
          {options.map((p) => {
            const on = selected.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onToggle(p)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                <span
                  className={cn(
                    "grid size-3.5 shrink-0 place-items-center rounded border",
                    on
                      ? "border-foreground bg-foreground text-background"
                      : "border-border",
                  )}
                >
                  {on && <Check className="size-2.5" />}
                </span>
                <span className="truncate">{p.name}</span>
                {p.position && (
                  <span className="truncate text-muted-foreground">
                    {p.position}
                  </span>
                )}
              </button>
            );
          })}
          {name.trim() &&
            !options.some(
              (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
            ) && (
              <button
                type="button"
                onClick={add}
                disabled={create.isPending}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                <Plus className="size-3.5 text-muted-foreground" />
                Add “{name.trim()}”{company ? ` at ${company.name}` : ""}
              </button>
            )}
          {!name.trim() && options.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
              Type a name to find or add someone.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
