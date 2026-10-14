"use client";

/**
 * CRM — each opportunity (a lead) on a board, and what happened on it as a
 * thread of updates. Plan + rationale: docs/plans/crm.md.
 *
 * Four sections — the **Leads** board (home), **Activity** (every update,
 * newest first), **People** and **Companies** — picked from the sidebar
 * (sub-items under CRM; `?tab=`). Opening a lead (`l`) or a contact (`c`)
 * slides a detail pane in beside whichever section you're on.
 *
 * Everything that defines what you're looking at lives in the URL, so any
 * state is a shareable link and the back button walks through it.
 *
 * Layout invariant (see CLAUDE.md): immediate child of the app shell, so the
 * root is ``h-full flex`` and every scroll surface carries ``min-h-0``.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Plus, Search, X } from "lucide-react";

import { CompaniesView } from "@/components/crm/CompaniesView";
import { ContactDetail } from "@/components/crm/ContactDetail";
import { ContactEditDialog } from "@/components/crm/ContactEditDialog";
import { ContactsView } from "@/components/crm/ContactsView";
import { LeadDetail } from "@/components/crm/LeadDetail";
import { LeadsBoard } from "@/components/crm/LeadsBoard";
import { NewLeadDialog, type NewLeadDefaults } from "@/components/crm/NewLeadDialog";
import { UpdateFeed } from "@/components/crm/UpdateFeed";
import { Chip, Empty, primaryBtnCls } from "@/components/crm/shared";
import { useContacts, useCrmActivity, useCrmProjects, useLeads } from "@/hooks/use-crm";
import { useUrlParams, useUrlSearch } from "@/hooks/use-url-params";
import { connectCrmSocket } from "@/lib/crm-ws";
import { CRM_SECTIONS, type CrmSection } from "@/lib/crm-meta";
import { cn } from "@/lib/utils";

const ACTIVITY_WINDOWS = [7, 30, 90, 365];

export default function CrmPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <Crm />
    </Suspense>
  );
}

function Crm() {
  const { params, setParams } = useUrlParams();
  const queryClient = useQueryClient();
  useEffect(() => connectCrmSocket(queryClient), [queryClient]);

  const section = CRM_SECTIONS.find((t) => t.id === params.get("tab")) ?? CRM_SECTIONS[0];
  const tab: CrmSection = section.id;
  const listTab = tab === "people" || tab === "companies";
  const contactId = params.get("c") ? Number(params.get("c")) : null;
  const leadKey = params.get("l");

  // Scope: one of our businesses (project prefix, e.g. MOW) or everything.
  const crmProjects = useCrmProjects();
  const scope = params.get("p") ?? "";
  const scopeProject = crmProjects.data?.find(
    (p) => p.prefix.toLowerCase() === scope.toLowerCase(),
  );

  const openContact = useCallback(
    (id: number) => setParams({ c: String(id), l: null }, { push: !contactId && !leadKey }),
    [setParams, contactId, leadKey],
  );
  const openLead = useCallback(
    (key: string) => setParams({ l: key, c: null }, { push: !contactId && !leadKey }),
    [setParams, contactId, leadKey],
  );
  const closeDetail = () => setParams({ c: null, l: null });

  const { urlSearch, search, setSearch } = useUrlSearch(params, setParams);
  const contacts = useContacts(
    { search: urlSearch, kind: tab === "companies" ? "company" : "person", project: scope },
    listTab,
  );
  const leads = useLeads(scope, tab === "leads");
  const days = Number(params.get("days")) || 30;
  const activity = useCrmActivity(days, scope, tab === "activity");

  const [newContact, setNewContact] = useState(false);
  const [newLead, setNewLead] = useState<NewLeadDefaults | null>(null);
  const detailOpen = contactId != null || leadKey != null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className={cn("shrink-0 border-b border-border/80", detailOpen && "max-lg:hidden")}>
        <div className="flex min-h-12 items-center gap-2 px-4 max-sm:flex-wrap max-sm:py-2">
          <section.icon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="flex min-w-0 items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground max-sm:hidden">CRM</span>
            <span className="text-muted-foreground/50 max-sm:hidden">/</span>
            <span className="truncate font-medium">{section.label}</span>
          </h1>

          {(crmProjects.data?.length ?? 0) > 0 && (
            // Own line on phones so the section title isn't squeezed out.
            <nav
              aria-label="Project"
              className="ml-2 flex shrink-0 rounded-md border border-border p-0.5 max-sm:order-last max-sm:ml-0"
            >
              {[{ id: 0, prefix: "", name: "All", color: "" }, ...crmProjects.data!].map((p) => {
                const active = (scopeProject?.prefix ?? "") === p.prefix;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setParams({ p: p.prefix || null })}
                    className={cn(
                      "tap-target flex h-6 items-center gap-1.5 rounded px-2 text-[12px] text-muted-foreground hover:text-foreground",
                      active && "bg-accent text-foreground",
                    )}
                  >
                    {p.color && <span className="size-1.5 rounded-full" style={{ background: p.color }} />}
                    {p.name}
                  </button>
                );
              })}
            </nav>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {listTab ? (
              <button type="button" className={primaryBtnCls} onClick={() => setNewContact(true)}>
                <Plus className="size-3.5" />
                <span className="max-sm:hidden">{tab === "companies" ? "Company" : "Person"}</span>
              </button>
            ) : (
              <button
                type="button"
                className={primaryBtnCls}
                onClick={() => setNewLead({ project: scopeProject?.id })}
              >
                <Plus className="size-3.5" />
                <span className="max-sm:hidden">Lead</span>
              </button>
            )}
          </div>
        </div>

        {listTab && (
          <div className="flex items-center gap-1.5 px-4 pb-2">
            <label className="flex h-7 w-64 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-border px-2 focus-within:border-ring">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tab === "companies" ? "Search every company…" : "Search everyone — name, email, company…"}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
              />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                  <X className="size-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </label>
          </div>
        )}
        {tab === "activity" && (
          <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
            <span className="text-[12px] text-muted-foreground">Last</span>
            {ACTIVITY_WINDOWS.map((d) => (
              <Chip key={d} active={days === d} onClick={() => setParams({ days: d === 30 ? null : String(d) })}>
                {d} days
              </Chip>
            ))}
            {activity.data && (
              <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">
                {activity.data.length} updates
              </span>
            )}
          </div>
        )}
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <main className={cn("min-h-0 min-w-0 flex-1", detailOpen && "max-lg:hidden")}>
          {tab === "leads" ? (
            leads.isLoading ? (
              <Empty>Loading…</Empty>
            ) : leads.isError ? (
              <Empty tone="error">Couldn’t load leads.</Empty>
            ) : (
              <LeadsBoard
                leads={leads.data ?? []}
                selectedKey={leadKey}
                project={scope}
                onOpen={openLead}
                onNewLead={(stage) => setNewLead({ stage, project: scopeProject?.id })}
              />
            )
          ) : tab === "activity" ? (
            activity.isLoading ? (
              <Empty>Loading…</Empty>
            ) : activity.isError ? (
              <Empty tone="error">Couldn’t load activity.</Empty>
            ) : (
              <div className="h-full min-h-0 overflow-y-auto pb-10">
                <div className="mx-auto max-w-4xl px-2 pt-2">
                  <UpdateFeed
                    updates={activity.data ?? []}
                    showLead
                    onOpenContact={openContact}
                    onOpenLead={openLead}
                    empty={`No updates in the last ${days} days.`}
                  />
                </div>
              </div>
            )
          ) : contacts.isLoading ? (
            <Empty>Loading…</Empty>
          ) : contacts.isError ? (
            <Empty tone="error">Couldn’t load contacts.</Empty>
          ) : (contacts.data?.length ?? 0) === 0 ? (
            <Empty>
              {urlSearch
                ? `No ${tab === "companies" ? "companies" : "people"} match “${urlSearch}”.`
                : tab === "companies"
                  ? "Companies show up here once they have a lead."
                  : "People show up here once an update tags them or their company has a lead. Search to find anyone meetings know."}
            </Empty>
          ) : tab === "companies" ? (
            <CompaniesView
              companies={contacts.data!}
              selectedId={contactId}
              onOpen={openContact}
              compact={detailOpen}
            />
          ) : (
            <ContactsView contacts={contacts.data!} selectedId={contactId} onOpen={openContact} />
          )}
        </main>

        {detailOpen && (
          <aside className="flex min-h-0 w-full shrink-0 flex-col border-border lg:w-[32rem] lg:border-l xl:w-[40rem]">
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
                  onOpenLead={openLead}
                  onNewLead={(company) => setNewLead({ company, project: scopeProject?.id })}
                />
              ) : (
                <LeadDetail
                  key={leadKey}
                  leadKey={leadKey!}
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
      <NewLeadDialog defaults={newLead} onClose={() => setNewLead(null)} onCreated={openLead} />
    </div>
  );
}
