"use client";

/**
 * CRM — who we're talking to, where each opportunity stands, what we owe
 * whom next. Plan + rationale: docs/plans/crm.md.
 *
 * Five sections over the same people — the follow-up **Inbox** (home),
 * **People**, **Companies**, the **Deals** board and **Activity** — picked
 * from the sidebar (sub-items under CRM; `?tab=`). Opening a contact or deal
 * slides a detail pane in beside whichever section you're on.
 *
 * Everything that defines what you're looking at — tab, filters, pipeline,
 * the open contact (`c`) or deal (`d`) — lives in the URL, so any state is a
 * shareable link and the back button walks through it.
 *
 * Layout invariant (see CLAUDE.md): immediate child of the app shell, so the
 * root is ``h-full flex`` and every scroll surface carries ``min-h-0``.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Plus, Search, Settings2, X } from "lucide-react";

import { ActivityTimeline } from "@/components/crm/ActivityTimeline";
import { CompaniesView } from "@/components/crm/CompaniesView";
import { ContactDetail } from "@/components/crm/ContactDetail";
import { ContactEditDialog } from "@/components/crm/ContactEditDialog";
import { ContactsView } from "@/components/crm/ContactsView";
import {
  NewDealDialog,
  type NewDealDefaults,
  PipelineEditorDialog,
} from "@/components/crm/DealDialogs";
import { DealDetail } from "@/components/crm/DealDetail";
import { DealsBoard } from "@/components/crm/DealsBoard";
import { InboxView } from "@/components/crm/InboxView";
import { Empty, controlCls, primaryBtnCls } from "@/components/crm/shared";
import {
  type ContactFilters,
  useContacts,
  useCrmActivity,
  useDeals,
  usePipelines,
} from "@/hooks/use-crm";
import { connectCrmSocket } from "@/lib/crm-ws";
import {
  CRM_SECTIONS,
  type CrmSection,
  RELATIONSHIP_META,
  RELATIONSHIP_ORDER,
} from "@/lib/crm-meta";
import { connectMeetingsSocket } from "@/lib/meetings-ws";
import { cn } from "@/lib/utils";


const ACTIVITY_WINDOWS = [7, 14, 30, 90];

const SORTS = [
  { id: "last_contact", label: "Last contact" },
  { id: "next_follow_up", label: "Next follow-up" },
  { id: "name", label: "Name" },
  { id: "created", label: "Recently added" },
  { id: "open_deals", label: "Open deals" },
];

export default function CrmPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <Crm />
    </Suspense>
  );
}

function Crm() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => connectCrmSocket(queryClient), [queryClient]);
  // A new recording moves "last contact", so meeting events refresh us too.
  useEffect(
    () => connectMeetingsSocket(queryClient, ["crm"]),
    [queryClient],
  );

  // "contacts" is the pre-split name of the People tab; old links keep working.
  const rawTab = params.get("tab") === "contacts" ? "people" : params.get("tab");
  const section = CRM_SECTIONS.find((t) => t.id === rawTab) ?? CRM_SECTIONS[0];
  const tab: CrmSection = section.id;
  const listTab = tab === "people" || tab === "companies";
  const contactId = params.get("c") ? Number(params.get("c")) : null;
  const dealKey = params.get("d");
  const mine = params.get("mine") === "1";
  const owner = mine ? "me" : "";

  const setParams = useCallback(
    (patch: Record<string, string | null>, opts?: { push?: boolean }) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      // Opening a record is a navigation (back closes it); tweaking a filter isn't.
      if (opts?.push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [params, pathname, router],
  );

  const openContact = useCallback(
    (id: number) => setParams({ c: String(id), d: null }, { push: !contactId && !dealKey }),
    [setParams, contactId, dealKey],
  );
  const openDeal = useCallback(
    (key: string) => setParams({ d: key, c: null }, { push: !contactId && !dealKey }),
    [setParams, contactId, dealKey],
  );
  const closeDetail = () => setParams({ c: null, d: null });

  // ── Contacts filters (search is local, debounced into the URL) ──────────
  const urlSearch = params.get("q") ?? "";
  const [search, setSearch] = useState(urlSearch);
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

  const filters: ContactFilters = useMemo(
    () => ({
      search: urlSearch,
      relationship: params.get("rel") ?? "",
      kind: tab === "companies" ? "company" : "person",
      no_next_step: params.get("nonext") ?? "",
      owner,
      sort: params.get("sort") ?? "last_contact",
    }),
    [urlSearch, params, owner, tab],
  );
  const contacts = useContacts(filters, listTab);

  // ── Deals ───────────────────────────────────────────────────────────────
  const pipelines = usePipelines();
  const pipelineParam = params.get("pipeline");
  const pipeline =
    pipelines.data?.find((p) => String(p.id) === pipelineParam) ?? pipelines.data?.[0] ?? null;
  const deals = useDeals(tab === "deals" ? (pipeline?.id ?? null) : null);

  // ── Activity ────────────────────────────────────────────────────────────
  const days = Number(params.get("days")) || 14;
  const activity = useCrmActivity(days, tab === "activity");

  // ── Dialogs ─────────────────────────────────────────────────────────────
  const [newContact, setNewContact] = useState(false);
  const [newDeal, setNewDeal] = useState<NewDealDefaults | null>(null);
  const [editPipeline, setEditPipeline] = useState<"edit" | "new" | null>(null);

  const detailOpen = contactId != null || dealKey != null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className={cn("shrink-0 border-b border-border/80", detailOpen && "max-lg:hidden")}>
        <div className="flex min-h-12 items-center gap-2 px-4">
          <section.icon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="flex min-w-0 items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground max-sm:hidden">CRM</span>
            <span className="text-muted-foreground/50 max-sm:hidden">/</span>
            <span className="truncate font-medium">{section.label}</span>
          </h1>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <div className="flex rounded-md border border-border p-0.5">
              {[
                { id: false, label: "All" },
                { id: true, label: "Mine" },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={mine === o.id}
                  onClick={() => setParams({ mine: o.id ? "1" : null })}
                  className={cn(
                    "tap-target h-6 rounded px-2 text-[12px] text-muted-foreground hover:text-foreground",
                    mine === o.id && "bg-accent text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {tab === "deals" ? (
              <button
                type="button"
                className={primaryBtnCls}
                onClick={() => setNewDeal({ pipeline: pipeline?.id })}
                disabled={!pipeline}
              >
                <Plus className="size-3.5" />
                <span className="max-sm:hidden">Deal</span>
              </button>
            ) : (
              <button type="button" className={primaryBtnCls} onClick={() => setNewContact(true)}>
                <Plus className="size-3.5" />
                <span className="max-sm:hidden">
                  {tab === "companies" ? "Company" : "Contact"}
                </span>
              </button>
            )}
          </div>
        </div>

        {listTab && (
          <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
            <label className="flex h-7 w-56 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 focus-within:border-ring">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tab === "companies" ? "Company name…" : "Name, email, company…"}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
              />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                  <X className="size-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </label>
            {RELATIONSHIP_ORDER.filter((r) => r !== "internal").map((r) => {
              const active = filters.relationship === r;
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setParams({ rel: active ? null : r })}
                  className={cn(
                    "h-7 shrink-0 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    active && "border-foreground/40 bg-accent text-foreground",
                  )}
                >
                  {RELATIONSHIP_META[r].label}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={!!filters.no_next_step}
              onClick={() => setParams({ nonext: filters.no_next_step ? null : "1" })}
              className={cn(
                "h-7 shrink-0 rounded-md border border-dashed border-border px-2 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                filters.no_next_step && "border-solid border-foreground/40 bg-accent text-foreground",
              )}
            >
              No next step
            </button>
            <label className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[12px] text-muted-foreground">
              <span className="max-lg:hidden">Sort</span>
              <select
                className={controlCls}
                value={filters.sort}
                onChange={(e) =>
                  setParams({ sort: e.target.value === "last_contact" ? null : e.target.value })
                }
              >
                {SORTS.filter((s) => s.id !== "open_deals" || tab === "companies").map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {tab === "deals" && (pipelines.data?.length ?? 0) > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
            {pipelines.data!.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={pipeline?.id === p.id}
                onClick={() => setParams({ pipeline: String(p.id) })}
                className={cn(
                  "h-7 shrink-0 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  pipeline?.id === p.id && "border-foreground/40 bg-accent text-foreground",
                )}
              >
                {p.name}
                <span className="ml-1.5 tabular-nums text-muted-foreground/60">
                  {p.stages.reduce((n, s) => n + s.deal_count, 0)}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEditPipeline("new")}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3.5" /> Pipeline
            </button>
            <button
              type="button"
              onClick={() => setEditPipeline("edit")}
              className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings2 className="size-3.5" /> Stages
            </button>
          </div>
        )}
        {tab === "activity" && (
          <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
            <span className="text-[12px] text-muted-foreground">Last</span>
            {ACTIVITY_WINDOWS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                onClick={() => setParams({ days: d === 14 ? null : String(d) })}
                className={cn(
                  "h-7 shrink-0 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  days === d && "border-foreground/40 bg-accent text-foreground",
                )}
              >
                {d} days
              </button>
            ))}
            {activity.data && (
              <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">
                {activity.data.length} entries
              </span>
            )}
          </div>
        )}
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <main className={cn("min-h-0 min-w-0 flex-1", detailOpen && "max-lg:hidden")}>
          {tab === "inbox" ? (
            <InboxView owner={owner} onOpenContact={openContact} />
          ) : tab === "activity" ? (
            activity.isLoading ? (
              <Empty>Loading…</Empty>
            ) : activity.isError ? (
              <Empty tone="error">Couldn’t load activity.</Empty>
            ) : (
              <div className="h-full min-h-0 overflow-y-auto pb-10 pt-2">
                <div className="mx-auto max-w-3xl">
                  <ActivityTimeline
                    items={activity.data ?? []}
                    showPeople
                    groupByDay
                    onOpenContact={openContact}
                    empty={`Nothing logged in the last ${days} days.`}
                  />
                </div>
              </div>
            )
          ) : listTab ? (
            contacts.isLoading ? (
              <Empty>Loading…</Empty>
            ) : contacts.isError ? (
              <Empty tone="error">Couldn’t load contacts.</Empty>
            ) : (contacts.data?.length ?? 0) === 0 ? (
              <Empty>
                {urlSearch || filters.relationship || filters.no_next_step ? (
                  `No ${tab === "companies" ? "companies" : "people"} match these filters.`
                ) : (
                  <>
                    No contacts yet. Add one, promote someone from a meeting, or
                    ask Claude to <span className="font-mono text-[12px]">upsert_contact</span>.
                  </>
                )}
              </Empty>
            ) : tab === "companies" ? (
              <CompaniesView
                companies={contacts.data!}
                selectedId={contactId}
                onOpen={openContact}
                compact={detailOpen}
              />
            ) : (
              <ContactsView
                contacts={contacts.data!}
                selectedId={contactId}
                onOpen={openContact}
              />
            )
          ) : pipelines.isLoading || deals.isLoading ? (
            <Empty>Loading…</Empty>
          ) : !pipeline ? (
            <Empty>No pipelines. Create one to start tracking deals.</Empty>
          ) : (
            <DealsBoard
              pipeline={pipeline}
              deals={deals.data ?? []}
              selectedKey={dealKey}
              onOpen={openDeal}
              onNewDeal={(stage) => setNewDeal({ pipeline: pipeline.id, stage })}
            />
          )}
        </main>

        {detailOpen && (
          <aside className="flex min-h-0 w-full shrink-0 flex-col border-border lg:w-[30rem] lg:border-l xl:w-[34rem]">
            <button
              type="button"
              onClick={closeDetail}
              className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2.5 text-[13px] text-muted-foreground active:bg-accent lg:hidden"
            >
              <ChevronLeft className="size-4" />
              CRM
            </button>
            <div className="min-h-0 flex-1">
              {contactId != null ? (
                <ContactDetail
                  key={contactId}
                  contactId={contactId}
                  onClose={closeDetail}
                  onOpenContact={openContact}
                  onOpenDeal={openDeal}
                  onNewDeal={(company) => setNewDeal({ company })}
                />
              ) : (
                <DealDetail
                  key={dealKey}
                  dealKey={dealKey!}
                  onClose={closeDetail}
                  onOpenContact={openContact}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      <ContactEditDialog
        open={newContact}
        onOpenChange={setNewContact}
        defaultKind={tab === "companies" ? "company" : "person"}
        onCreated={openContact}
      />
      <NewDealDialog
        defaults={newDeal}
        onClose={() => setNewDeal(null)}
        onCreated={openDeal}
      />
      <PipelineEditorDialog
        pipeline={editPipeline === "edit" ? pipeline : null}
        open={editPipeline != null}
        onOpenChange={(o) => !o && setEditPipeline(null)}
        onSelectPipeline={(id) => setParams({ pipeline: String(id) })}
      />
    </div>
  );
}
