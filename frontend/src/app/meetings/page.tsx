"use client";

/**
 * Meetings — recorded conversations pushed in by the recording pipeline.
 *
 * Three views over the *same* filtered set: a node graph (meetings ↔ people ↔
 * companies ↔ projects), a swimlane timeline, and a grouped list. Opening a
 * meeting slides a detail pane in beside whichever view you're on.
 *
 * Everything that defines what you're looking at — view, grouping, filters,
 * the open meeting — lives in the URL, so any state is a shareable link
 * (`/meetings?view=graph&entity=12&m=MTG-014`) and the browser's back button
 * walks through it.
 *
 * Layout invariant (see CLAUDE.md): immediate child of the app shell, so the
 * root is ``h-full flex`` and every scroll surface carries ``min-h-0``.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  AudioLines,
  ChevronLeft,
  GanttChart,
  List,
  Search,
  Share2,
  Sparkles,
  X,
} from "lucide-react";

import { MeetingDetail } from "@/components/meetings/MeetingDetail";
import {
  type ListGroupBy,
  MeetingList,
} from "@/components/meetings/MeetingList";
import { MeetingTimeline } from "@/components/meetings/MeetingTimeline";
import { MeetingsGraph } from "@/components/meetings/MeetingsGraph";
import type { GroupBy } from "@/components/meetings/graph-layout";
import {
  type MeetingFilters,
  useMeetingEntities,
  useMeetingFacets,
  useMeetingGraph,
  useMeetings,
} from "@/hooks/use-meetings";
import { connectMeetingsSocket } from "@/lib/meetings-ws";
import { cn } from "@/lib/utils";

type ViewMode = "graph" | "timeline" | "list";

const VIEWS: { id: ViewMode; label: string; icon: typeof List }[] = [
  { id: "graph", label: "Graph", icon: Share2 },
  { id: "timeline", label: "Timeline", icon: GanttChart },
  { id: "list", label: "List", icon: List },
];

/** Group-by options differ per view: the graph can float free ("none"), and
 *  only people make sense as list/timeline lanes. */
const GROUPS: Record<ViewMode, { id: string; label: string }[]> = {
  graph: [
    { id: "company", label: "Company" },
    { id: "project", label: "Project" },
    { id: "category", label: "Category" },
    { id: "month", label: "Month" },
    { id: "none", label: "No grouping" },
  ],
  timeline: [
    { id: "company", label: "Company" },
    { id: "person", label: "Person" },
    { id: "category", label: "Category" },
    { id: "project", label: "Project" },
  ],
  list: [
    { id: "month", label: "Month" },
    { id: "company", label: "Company" },
    { id: "person", label: "Person" },
    { id: "category", label: "Category" },
    { id: "project", label: "Project" },
  ],
};

const controlCls =
  "h-7 shrink-0 rounded-md border border-border bg-transparent px-1.5 text-[12px] text-foreground outline-none hover:bg-accent/50 focus-visible:border-ring";

export default function MeetingsPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <Meetings />
    </Suspense>
  );
}

function Meetings() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => connectMeetingsSocket(queryClient), [queryClient]);

  const view = (VIEWS.find((v) => v.id === params.get("view"))?.id ??
    "graph") as ViewMode;
  const groupOptions = GROUPS[view];
  const group =
    groupOptions.find((g) => g.id === params.get("group"))?.id ??
    groupOptions[0].id;
  const selectedKey = params.get("m");
  const entityParam = params.get("entity");
  const showMentioned = params.get("mentioned") === "1";

  const setParams = useCallback(
    (patch: Record<string, string | null>, opts?: { push?: boolean }) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      // Opening a meeting is a navigation (back closes it); tweaking a filter isn't.
      if (opts?.push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [params, pathname, router],
  );

  // The search box is local state, debounced into the URL.
  const urlSearch = params.get("q") ?? "";
  const [search, setSearch] = useState(urlSearch);
  // Follow the URL when it changes underneath us (back button, shared link)
  // — but not when the change is just our own debounced write landing.
  // `router.replace` is async: without this guard, a character typed while it
  // is in flight would be overwritten by the older value coming back.
  const [sync, setSync] = useState({ seen: urlSearch, sent: urlSearch });
  if (sync.seen !== urlSearch) {
    setSync({ seen: urlSearch, sent: urlSearch });
    if (urlSearch !== sync.sent) setSearch(urlSearch);
  }
  useEffect(() => {
    const next = search.trim();
    if (next === urlSearch) return;
    const t = setTimeout(() => {
      setSync((s) => ({ ...s, sent: next }));
      setParams({ q: next || null });
    }, 250);
    return () => clearTimeout(t);
  }, [search, urlSearch, setParams]);

  const filters: MeetingFilters = useMemo(
    () => ({
      search: urlSearch,
      category: params.get("category") ?? "",
      project: params.get("project") ?? "",
      tag: params.get("tag") ?? "",
      entity: entityParam ?? "",
    }),
    [urlSearch, params, entityParam],
  );
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const facets = useMeetingFacets();
  const entities = useMeetingEntities();
  // Only the visible view's query runs — except that the header's "9 of 34"
  // needs the list as soon as a filter is on.
  const meetings = useMeetings(
    filters,
    view !== "graph" || activeFilterCount > 0,
  );
  const graph = useMeetingGraph(
    filters,
    { mentioned: showMentioned, projects: true },
    view === "graph",
  );

  const focusedEntity = entityParam
    ? entities.data?.find((e) => String(e.id) === entityParam)
    : undefined;

  const openMeeting = useCallback(
    (key: string) => setParams({ m: key }, { push: !selectedKey }),
    [setParams, selectedKey],
  );
  const focusEntity = useCallback(
    (id: number) =>
      setParams({ entity: String(id) === entityParam ? null : String(id) }),
    [setParams, entityParam],
  );

  const total = facets.data?.total;
  const rows = meetings.data ?? [];
  const isEmpty = total === 0;
  const loading = view === "graph" ? graph.isLoading : meetings.isLoading;
  const failed = view === "graph" ? graph.isError : meetings.isError;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header
        className={cn(
          "shrink-0 border-b border-border/80",
          // On mobile the open meeting takes the whole screen.
          selectedKey && "max-lg:hidden",
        )}
      >
        <div className="flex min-h-12 items-center gap-2 px-4">
          <AudioLines className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="text-[13px] font-medium">Meetings</h1>
          {total != null && (
            <span className="text-[11px] tabular-nums text-muted-foreground/60">
              {activeFilterCount ? `${rows.length} of ${total}` : total}
            </span>
          )}

          <label className="ml-2 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border px-2 focus-within:border-ring lg:max-w-xs">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles, transcripts, people…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
              >
                <X className="size-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </label>

          <div className="ml-auto flex shrink-0 rounded-md border border-border p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                title={v.label}
                onClick={() =>
                  setParams({
                    view: v.id === "graph" ? null : v.id,
                    group: null,
                  })
                }
                className={cn(
                  "tap-target flex h-6 items-center gap-1.5 rounded px-2 text-[12px] text-muted-foreground hover:text-foreground",
                  view === v.id && "bg-accent text-foreground",
                )}
              >
                <v.icon className="size-3.5" />
                <span className="max-lg:hidden">{v.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
          {(facets.data?.categories ?? [])
            .filter((c) => c.count > 0)
            .map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={filters.category === c.value}
                onClick={() =>
                  setParams({
                    category: filters.category === c.value ? null : c.value,
                  })
                }
                className={cn(
                  "h-7 shrink-0 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  filters.category === c.value &&
                    "border-foreground/40 bg-accent text-foreground",
                )}
              >
                {c.label}
                <span className="ml-1.5 tabular-nums text-muted-foreground/60">
                  {c.count}
                </span>
              </button>
            ))}

          {(facets.data?.projects.length ?? 0) > 0 && (
            <select
              aria-label="Project"
              className={controlCls}
              value={filters.project}
              onChange={(e) => setParams({ project: e.target.value || null })}
            >
              <option value="">All projects</option>
              {facets.data!.projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.project__name} ({p.count})
                </option>
              ))}
            </select>
          )}
          {(facets.data?.tags.length ?? 0) > 0 && (
            <select
              aria-label="Tag"
              className={controlCls}
              value={filters.tag}
              onChange={(e) => setParams({ tag: e.target.value || null })}
            >
              <option value="">All tags</option>
              {facets.data!.tags.map((t) => (
                <option key={t.name} value={t.name}>
                  #{t.name} ({t.count})
                </option>
              ))}
            </select>
          )}

          {entityParam && (
            <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-foreground/40 bg-accent pl-2 pr-1 text-[12px]">
              <span className="font-medium">{focusedEntity?.name ?? "…"}</span>
              {focusedEntity?.company_name && (
                <span className="text-muted-foreground">
                  {focusedEntity.company_name}
                </span>
              )}
              {focusedEntity?.wiki_slug && (
                <a
                  href={`/llm-wiki#w/${focusedEntity.wiki_slug}`}
                  title="Open LLM-wiki page"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Sparkles className="size-3" />
                </a>
              )}
              <button
                type="button"
                aria-label="Clear person/company filter"
                onClick={() => setParams({ entity: null })}
                className="grid size-5 place-items-center rounded hover:bg-background/60"
              >
                <X className="size-3" />
              </button>
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            {view === "graph" && (
              <label className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-foreground"
                  checked={showMentioned}
                  onChange={(e) =>
                    setParams({ mentioned: e.target.checked ? "1" : null })
                  }
                />
                Mentions
              </label>
            )}
            <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
              <span className="max-lg:hidden">Group</span>
              <select
                className={controlCls}
                value={group}
                onChange={(e) => setParams({ group: e.target.value })}
              >
                {groupOptions.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            selectedKey && "max-lg:hidden",
          )}
        >
          {isEmpty ? (
            <Empty>
              No meetings yet. The recording pipeline adds them here once a
              recording has been transcribed and briefed.
            </Empty>
          ) : failed ? (
            <Empty tone="error">Couldn’t load meetings.</Empty>
          ) : loading ? (
            <Empty>Loading…</Empty>
          ) : view === "graph" ? (
            graph.data && graph.data.nodes.length > 0 ? (
              <MeetingsGraph
                graph={graph.data}
                groupBy={group as GroupBy}
                selectedKey={selectedKey}
                focusedEntityId={entityParam ? Number(entityParam) : null}
                onSelectMeeting={openMeeting}
                onSelectEntity={focusEntity}
                onSelectProject={(id) =>
                  setParams({
                    project: filters.project === String(id) ? null : String(id),
                  })
                }
              />
            ) : (
              <Empty>No meetings match these filters.</Empty>
            )
          ) : rows.length === 0 ? (
            <Empty>No meetings match these filters.</Empty>
          ) : view === "timeline" ? (
            <MeetingTimeline
              meetings={rows}
              groupBy={group as ListGroupBy}
              selectedKey={selectedKey}
              onOpen={openMeeting}
            />
          ) : (
            <MeetingList
              meetings={rows}
              groupBy={group as ListGroupBy}
              selectedKey={selectedKey}
              searchTerm={urlSearch}
              onOpen={openMeeting}
              onSelectEntity={focusEntity}
            />
          )}
        </main>

        {selectedKey && (
          <aside className="flex min-h-0 w-full shrink-0 flex-col border-border lg:w-[30rem] lg:border-l xl:w-[34rem]">
            <button
              type="button"
              onClick={() => setParams({ m: null })}
              className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2.5 text-[13px] text-muted-foreground active:bg-accent lg:hidden"
            >
              <ChevronLeft className="size-4" />
              Meetings
            </button>
            <div className="min-h-0 flex-1">
              <MeetingDetail
                // Remount per meeting so tab + transcript search reset.
                key={selectedKey}
                meetingKey={selectedKey}
                onClose={() => setParams({ m: null })}
                onOpenMeeting={openMeeting}
                onSelectEntity={focusEntity}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Empty({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "grid h-full place-items-center px-6 text-center text-[13px] text-muted-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      <p className="max-w-sm">{children}</p>
    </div>
  );
}
