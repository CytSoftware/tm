"use client";

/**
 * One meeting: what was said (brief, transcript), what came out of it (action
 * items → tasks) and what it connects to (related meetings).
 *
 * The brief is rendered from **markdown** through the shared safe renderer.
 * The pipeline's styled HTML brief is never rendered in-app — "Styled brief"
 * opens it at its own gshr.page URL instead.
 */

import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArrowUpRight,
  Check,
  ExternalLink,
  Link2,
  Link2Off,
  Plus,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  type ActionItem,
  type MeetingCategory,
  type MeetingDetail as Meeting,
  useCreateTaskFromActionItem,
  useLinkMeetings,
  useMeeting,
  useRelatedMeetings,
  useToggleActionItem,
  useUpdateMeeting,
} from "@/hooks/use-meetings";
import { useProjectsQuery } from "@/hooks/use-projects";
import { ApiError } from "@/lib/api";
import { md } from "@/lib/markdown";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  formatDuration,
} from "@/lib/meeting-meta";
import { useTaskDialog } from "@/lib/task-dialog";
import { cn } from "@/lib/utils";

import { CategoryDot, EntityChip } from "./MeetingRow";

type Tab = "brief" | "transcript" | "actions" | "related";

const selectCls =
  "h-7 max-w-44 truncate rounded-md border border-border bg-transparent px-1.5 text-[12px] text-foreground outline-none hover:bg-accent/50 focus-visible:border-ring";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const p = err.payload as { detail?: string | string[] } | null;
    const d = p?.detail;
    if (d) return Array.isArray(d) ? d.join(" ") : d;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function MeetingDetail({
  meetingKey,
  onClose,
  onOpenMeeting,
  onSelectEntity,
}: {
  meetingKey: string;
  onClose: () => void;
  onOpenMeeting: (key: string) => void;
  onSelectEntity: (id: number) => void;
}) {
  const meeting = useMeeting(meetingKey);
  const related = useRelatedMeetings(meetingKey);
  const [tab, setTab] = useState<Tab>("brief");
  const m = meeting.data;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "brief", label: "Brief" },
    { id: "transcript", label: "Transcript" },
    {
      id: "actions",
      label: "Actions",
      count: m?.open_action_item_count || undefined,
    },
    {
      id: "related",
      label: "Related",
      count: related.data?.length || undefined,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border px-4 pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono">{meetingKey}</span>
              {m && (
                <>
                  <span>·</span>
                  <span>
                    {format(new Date(m.started_at), "EEE d MMM yyyy, HH:mm")}
                  </span>
                  {m.duration_seconds ? (
                    <>
                      <span>·</span>
                      <span>{formatDuration(m.duration_seconds)}</span>
                    </>
                  ) : null}
                </>
              )}
            </div>
            <h1 className="mt-0.5 text-[15px] font-semibold leading-snug">
              {m?.title ?? (meeting.isLoading ? "Loading…" : "Meeting")}
            </h1>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close meeting"
            className="tap-target -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-lg:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        {m && <MetaBar meeting={m} onSelectEntity={onSelectEntity} />}

        <div className="-mb-px mt-2 flex gap-4 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "shrink-0 border-b-2 border-transparent pb-2 text-[13px] text-muted-foreground hover:text-foreground",
                tab === t.id && "border-foreground font-medium text-foreground",
              )}
            >
              {t.label}
              {t.count ? (
                <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground/70">
                  {t.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {meeting.isLoading ? (
          <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
        ) : meeting.isError || !m ? (
          <div className="p-4 text-[13px] text-destructive">
            {errorMessage(meeting.error) || "Couldn't load this meeting."}
          </div>
        ) : tab === "brief" ? (
          <Brief meeting={m} />
        ) : tab === "transcript" ? (
          <Transcript text={m.transcript_md} />
        ) : tab === "actions" ? (
          <Actions meeting={m} />
        ) : (
          <Related
            meetingKey={meetingKey}
            items={related.data ?? []}
            loading={related.isLoading}
            onOpenMeeting={onOpenMeeting}
          />
        )}
      </div>
    </div>
  );
}

// ── Meta: category, project, people, tags ───────────────────────────────────

function MetaBar({
  meeting,
  onSelectEntity,
}: {
  meeting: Meeting;
  onSelectEntity: (id: number) => void;
}) {
  const update = useUpdateMeeting(meeting.key);
  const projects = useProjectsQuery({ includeArchived: false });
  const save = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, { onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1.5">
          <CategoryDot category={meeting.category} />
          <span className="sr-only">Category</span>
          <select
            className={selectCls}
            value={meeting.category}
            disabled={update.isPending}
            onChange={(e) =>
              save({ category: e.target.value as MeetingCategory })
            }
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_META[c].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Project</span>
          <select
            className={selectCls}
            value={meeting.project?.id ?? ""}
            disabled={update.isPending}
            onChange={(e) => save({ project: e.target.value || null })}
          >
            <option value="">No project</option>
            {(projects.data?.results ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {meeting.gshr_url && (
          <a
            href={meeting.gshr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Styled brief
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {(meeting.entities.length > 0 || meeting.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {meeting.entities.map((e) => (
            <EntityChip key={e.id} entity={e} onSelect={onSelectEntity} />
          ))}
          {meeting.tags.map((t) => (
            <span key={t} className="px-1 text-[11px] text-muted-foreground">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Brief ───────────────────────────────────────────────────────────────────

function Brief({ meeting }: { meeting: Meeting }) {
  const html = useMemo(
    () => md.render(meeting.brief_md || meeting.summary || ""),
    [meeting.brief_md, meeting.summary],
  );
  if (!html.trim()) {
    return (
      <div className="p-4 text-[13px] text-muted-foreground">
        No brief for this meeting yet.
      </div>
    );
  }
  return (
    <article
      className="prose prose-sm dark:prose-invert max-w-none px-4 py-4 [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Transcript ──────────────────────────────────────────────────────────────

/** "**Ali:** text", "Ali: text" or "[00:12] Ali: text" → speaker + text. */
const SPEAKER =
  /^\s*(\[[^\]]+\]\s*)?\*{0,2}([^:*\n]{1,40}?)\*{0,2}:\*{0,2}\s+(.*)$/;

function Transcript({ text }: { text: string }) {
  const [query, setQuery] = useState("");
  const lines = useMemo(
    () =>
      text
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean),
    [text],
  );
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? lines.filter((l) => l.toLowerCase().includes(needle))
    : lines;

  if (!lines.length) {
    return (
      <div className="p-4 text-[13px] text-muted-foreground">
        No transcript.
      </div>
    );
  }

  const mark = (s: string) => {
    if (!needle) return s;
    const out: React.ReactNode[] = [];
    let i = 0;
    const lower = s.toLowerCase();
    for (
      let at = lower.indexOf(needle);
      at >= 0;
      at = lower.indexOf(needle, i)
    ) {
      out.push(s.slice(i, at));
      out.push(
        <mark
          key={at}
          className="rounded-sm bg-yellow-300/60 px-0.5 text-foreground dark:bg-yellow-500/40"
        >
          {s.slice(at, at + needle.length)}
        </mark>,
      );
      i = at + needle.length;
    }
    out.push(s.slice(i));
    return out;
  };

  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in transcript"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
        />
        {needle && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {shown.length} of {lines.length} lines
          </span>
        )}
      </div>
      <div
        className="space-y-2.5 px-4 py-3 text-[13px] leading-relaxed"
        dir="auto"
      >
        {shown.map((line, i) => {
          const hit = SPEAKER.exec(line);
          // Headings/rules from the markdown source read fine as plain text.
          const plain = line.replace(/^#+\s*/, "");
          return hit ? (
            <p key={i} dir="auto">
              {hit[1] && (
                <span className="mr-1.5 font-mono text-[11px] text-muted-foreground/70">
                  {hit[1].trim()}
                </span>
              )}
              <span className="font-medium text-foreground">
                {hit[2].trim()}
              </span>
              <span className="text-muted-foreground">: </span>
              <span className="text-foreground/85">{mark(hit[3])}</span>
            </p>
          ) : (
            <p key={i} dir="auto" className="text-foreground/85">
              {mark(plain)}
            </p>
          );
        })}
        {needle && shown.length === 0 && (
          <p className="text-muted-foreground">No lines match “{query}”.</p>
        )}
      </div>
    </div>
  );
}

// ── Action items + linked tasks ─────────────────────────────────────────────

function Actions({ meeting }: { meeting: Meeting }) {
  const toggle = useToggleActionItem(meeting.key);
  const createTask = useCreateTaskFromActionItem(meeting.key);
  const projects = useProjectsQuery({ includeArchived: false });
  const { openTaskByKey } = useTaskDialog();
  // Only needed when the meeting itself has no project to file tasks under.
  const [projectId, setProjectId] = useState("");

  const fromItems = new Set(
    meeting.action_items.map((i) => i.task_key).filter(Boolean),
  );
  const otherTasks = meeting.linked_tasks.filter((t) => !fromItems.has(t.key));
  const needsProject = !meeting.project;

  function makeTask(item: ActionItem) {
    createTask.mutate(
      { id: item.id, project: needsProject ? projectId : undefined },
      {
        onSuccess: () => toast.success("Task created"),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  }

  return (
    <div className="px-4 py-3">
      {meeting.action_items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No action items were pulled out of this meeting.
        </p>
      ) : (
        <>
          {needsProject && (
            <label className="mb-3 flex items-center gap-2 text-[12px] text-muted-foreground">
              Create tasks in
              <select
                className={selectCls}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Choose a project…</option>
                {(projects.data?.results ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ul className="space-y-1">
            {meeting.action_items.map((item) => (
              <li
                key={item.id}
                className="group flex items-start gap-2.5 rounded-md py-1.5"
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.done}
                  aria-label={item.done ? "Mark as not done" : "Mark as done"}
                  onClick={() =>
                    toggle.mutate(
                      { id: item.id, done: !item.done },
                      { onError: (e) => toast.error(errorMessage(e)) },
                    )
                  }
                  className={cn(
                    "tap-target mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-foreground/30 hover:border-foreground/60",
                    item.done &&
                      "border-foreground bg-foreground text-background",
                  )}
                >
                  {item.done && <Check className="size-3" strokeWidth={3} />}
                </button>
                <div className="min-w-0 flex-1">
                  <p
                    dir="auto"
                    className={cn(
                      "text-[13px] leading-snug",
                      item.done && "text-muted-foreground line-through",
                    )}
                  >
                    {item.text}
                  </p>
                  {item.owner && (
                    <p className="text-[11px] text-muted-foreground">
                      {item.owner}
                    </p>
                  )}
                </div>
                {item.task_key ? (
                  <button
                    type="button"
                    onClick={() => openTaskByKey(item.task_key!)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {item.task_key}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={
                      createTask.isPending || (needsProject && !projectId)
                    }
                    title={
                      needsProject && !projectId
                        ? "Choose a project first"
                        : "Create a task"
                    }
                    onClick={() => makeTask(item)}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100 hover-none:opacity-100"
                  >
                    <Plus className="size-3" />
                    Task
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {otherTasks.length > 0 && (
        <>
          <h3 className="mb-1 mt-5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Linked tasks
          </h3>
          <ul>
            {otherTasks.map((t) => (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => openTaskByKey(t.key)}
                  className="flex w-full items-center gap-2 rounded-md py-1.5 text-left text-[13px] hover:bg-accent/50"
                >
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {t.key}
                  </span>
                  <span
                    className={cn(
                      "truncate",
                      t.is_done && "text-muted-foreground line-through",
                    )}
                  >
                    {t.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {t.column}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Related meetings ────────────────────────────────────────────────────────

function Related({
  meetingKey,
  items,
  loading,
  onOpenMeeting,
}: {
  meetingKey: string;
  items: ReturnType<typeof useRelatedMeetings>["data"] & object;
  loading: boolean;
  onOpenMeeting: (key: string) => void;
}) {
  const link = useLinkMeetings(meetingKey);

  if (loading)
    return (
      <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
    );
  if (!items.length) {
    return (
      <div className="p-4 text-[13px] text-muted-foreground">
        Nothing shares people, a company, a project or tags with this meeting
        yet.
      </div>
    );
  }
  return (
    <ul className="py-1">
      {items.map((r) => (
        <li
          key={r.key}
          className="group flex items-start gap-2 border-b border-border/60 px-4 py-2.5 hover:bg-accent/40"
        >
          <button
            type="button"
            onClick={() => onOpenMeeting(r.key)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-2">
              <CategoryDot category={r.category} />
              <span className="truncate text-[13px] font-medium">
                {r.title}
              </span>
              <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground" />
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {format(new Date(r.started_at), "d MMM yyyy")}
              {r.link_kind && (
                <span className="ml-1.5 rounded bg-foreground/10 px-1 py-px font-medium text-foreground/80">
                  {r.link_kind === "follow_up" ? "Follow-up" : "Linked"}
                </span>
              )}
              {r.reasons.length > 0 && (
                <span className="ml-1.5">
                  Shares {r.reasons.slice(0, 4).join(", ")}
                </span>
              )}
            </div>
          </button>
          <button
            type="button"
            disabled={link.isPending}
            title={r.link_kind ? "Remove link" : "Link as follow-up"}
            aria-label={r.link_kind ? "Remove link" : "Link as follow-up"}
            onClick={() =>
              link.mutate(
                { to: r.key, remove: !!r.link_kind },
                { onError: (e) => toast.error(errorMessage(e)) },
              )
            }
            className={cn(
              "tap-target grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
              !r.link_kind &&
                "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover-none:opacity-100",
            )}
          >
            {r.link_kind ? (
              <Link2Off className="size-3.5" />
            ) : (
              <Link2 className="size-3.5" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
