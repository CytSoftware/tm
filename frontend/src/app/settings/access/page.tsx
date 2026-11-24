"use client";

/**
 * /settings/access — who can open which module and project (staff only;
 * `canOpen` refuses it to everyone else because no module opens it).
 *
 * People on the left, one person's access on the right, opened by a plain
 * summary of what they can actually see. Project-scoped modules share one
 * block with the project picker and stay disabled until a project is picked,
 * so the page can't express a grant that shows nothing. Groups mirror
 * `PROJECT_SCOPED` / `MODULE_ONLY` in `apps/tasks/access.py`; wiki and LLM
 * wiki filter by project through their own rules, so they sit in the project
 * block.
 *
 * Every toggle saves at once; the backend takes the full new list.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";

import { MasterDetail } from "@/components/layout/MasterDetail";
import { Switch } from "@/components/ui/switch";
import { type AccessUser, useAccessQuery, useUpdateAccess } from "@/hooks/use-access";
import type { ModuleKey } from "@/lib/types";
import { cn } from "@/lib/utils";

type Project = { id: number; prefix: string; name: string };
type ModuleInfo = { key: ModuleKey; label: string; hint: string };

const IN_PROJECTS: ModuleInfo[] = [
  { key: "tasks", label: "Tasks", hint: "Board, To Review, focus and recurring tasks" },
  { key: "crm", label: "CRM", hint: "Leads, activity, people and companies" },
  { key: "billing", label: "Billing", hint: "Payments and licences" },
  { key: "meetings", label: "Meetings", hint: "Recordings, briefs and action items" },
  { key: "reports", label: "Reports", hint: "Published reports" },
  { key: "wiki", label: "Wiki", hint: "Pages filed under these projects, plus pages they wrote" },
  { key: "llm_wiki", label: "LLM Wiki", hint: "Pages filed only under these projects" },
];

const COMPANY_WIDE: ModuleInfo[] = [
  { key: "bets", label: "Bets", hint: "Every project's bets and metrics" },
  { key: "analytics", label: "Analytics", hint: "Every project's throughput and completions" },
  { key: "operations", label: "Operations", hint: "Events, routines, services and monitoring" },
];

const DRIVE: ModuleInfo = {
  key: "drive",
  label: "Drive",
  hint: "Only files and folders they uploaded or were shared",
};

const SCOPED = new Set(IN_PROJECTS.map((m) => m.key));
const LABEL = Object.fromEntries(
  [...IN_PROJECTS, ...COMPANY_WIDE, DRIVE].map((m) => [m.key, m.label]),
) as Record<ModuleKey, string>;

const displayName = (u: AccessUser) => u.name || u.username;

/** A project-scoped module is on but no project is picked: it shows nothing. */
const emptyScoped = (u: AccessUser) =>
  !u.is_staff && u.project_ids.length === 0 && u.modules.some((m) => SCOPED.has(m));

function toggled<T>(list: T[], value: T, on: boolean): T[] {
  return on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Ordered module labels the user holds from `group`. */
function held(u: AccessUser, group: ModuleInfo[]): string[] {
  return group.filter((m) => u.modules.includes(m.key)).map((m) => m.label);
}

/** One sentence per kind of grant, in plain words. Empty = no access. */
function summary(u: AccessUser, projects: Project[]): string[] {
  const lines: string[] = [];
  const scoped = held(u, IN_PROJECTS);
  const names = projects.filter((p) => u.project_ids.includes(p.id)).map((p) => p.name);
  if (scoped.length && names.length) lines.push(`${list(scoped)} in ${list(names)}.`);
  const wide = held(u, COMPANY_WIDE);
  if (wide.length) lines.push(`${list(wide)} across every project.`);
  if (u.modules.includes("drive")) lines.push("Drive files shared with them.");
  return lines;
}

/** Short form for the people list. */
function shortSummary(u: AccessUser, projects: Project[]): string {
  if (u.is_staff) return "Staff · full access";
  const mods = u.modules.map((m) => LABEL[m] ?? m);
  if (!mods.length) return "No access";
  const prefixes = projects.filter((p) => u.project_ids.includes(p.id)).map((p) => p.prefix);
  return prefixes.length ? `${mods.join(", ")} · ${prefixes.join(", ")}` : mods.join(", ");
}

export default function AccessSettingsPage() {
  const query = useAccessQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const projects = useMemo(() => query.data?.projects ?? [], [query.data]);

  // Editable people first; staff after, since there's nothing to do on them.
  const users = useMemo(
    () =>
      [...(query.data?.users ?? [])].sort(
        (a, b) => Number(a.is_staff) - Number(b.is_staff) || displayName(a).localeCompare(displayName(b)),
      ),
    [query.data],
  );
  const selected = users.find((u) => u.id === selectedId) ?? null;

  if (query.isLoading) {
    return (
      <div className="h-full grid place-items-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }
  if (query.isError) {
    return <p className="p-6 text-[13px] text-muted-foreground">Couldn&apos;t load access. Try again shortly.</p>;
  }

  return (
    <MasterDetail
      railWidth="w-80"
      hasSelection={selected !== null}
      onBack={() => setSelectedId(null)}
      backLabel="People"
      master={
        <>
          <div className="shrink-0 h-14 px-4 border-b border-border/70 flex items-center">
            <span className="text-[14px] font-semibold tracking-tight">People</span>
          </div>
          <ul className="flex-1 min-h-0 overflow-y-auto p-2 space-y-0.5">
            {users.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(u.id)}
                  className={cn(
                    "w-full rounded-md px-3 py-2.5 text-left transition-colors",
                    u.id === selectedId ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{displayName(u)}</span>
                    {emptyScoped(u) && (
                      <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-label="Needs a project" />
                    )}
                  </span>
                  <span className="block mt-0.5 truncate text-[12px] text-muted-foreground">
                    {shortSummary(u, projects)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      }
      detail={
        selected ? (
          <UserAccess key={selected.id} user={selected} projects={projects} />
        ) : (
          <div className="flex-1 grid place-items-center p-6 text-[13px] text-muted-foreground">
            Pick a person to edit what they can open.
          </div>
        )
      }
    />
  );
}

function UserAccess({ user, projects }: { user: AccessUser; projects: Project[] }) {
  const update = useUpdateAccess();
  const setModule = (key: ModuleKey, on: boolean) =>
    update.mutate({ id: user.id, modules: toggled(user.modules, key, on) });
  const lines = summary(user, projects);
  const noProjects = user.project_ids.length === 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="px-8 max-lg:px-4 py-8 max-lg:py-5 space-y-8">
        <header className="space-y-3">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">{displayName(user)}</h1>
            {user.name && <p className="text-[13px] text-muted-foreground">{user.username}</p>}
          </div>
          {user.is_staff ? (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <ShieldCheck className="size-5 shrink-0 text-muted-foreground" />
              <p className="text-[13.5px]">
                Staff can open every module and project. To restrict this person, remove their
                staff status in the Django admin first.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                What they can see
              </p>
              {lines.length ? (
                <ul className="mt-1 space-y-0.5 text-[13.5px]">
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[13.5px] text-muted-foreground">Nothing yet.</p>
              )}
            </div>
          )}
        </header>

        {!user.is_staff && (
          <>
            <Section title="In their projects" hint="Pick the projects, then what they can open inside them.">
              <div className="col-span-full rounded-lg border border-border px-4 py-4">
                <p className="text-[12.5px] font-medium text-muted-foreground">Projects</p>
                {projects.length === 0 ? (
                  <p className="mt-2 text-[13px] text-muted-foreground">No projects yet.</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {projects.map((p) => {
                      const on = user.project_ids.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            update.mutate({ id: user.id, project_ids: toggled(user.project_ids, p.id, !on) })
                          }
                          className={cn(
                            "tap-target inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-[13px] transition-colors",
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border hover:bg-muted",
                          )}
                        >
                          {on && <Check className="size-3.5" />}
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {noProjects && (
                  <p className="mt-3 flex items-center gap-2 text-[12.5px] text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    Pick at least one project to turn these on.
                  </p>
                )}
              </div>
              {IN_PROJECTS.map((m) => (
                <ModuleRow
                  key={m.key}
                  module={m}
                  on={user.modules.includes(m.key)}
                  disabled={noProjects}
                  onChange={(on) => setModule(m.key, on)}
                />
              ))}
            </Section>

            <Section title="Across the company" hint="Projects don't apply — these show every project.">
              {COMPANY_WIDE.map((m) => (
                <ModuleRow key={m.key} module={m} on={user.modules.includes(m.key)} onChange={(on) => setModule(m.key, on)} />
              ))}
            </Section>

            <Section title="Files" hint="Projects don't apply — Drive uses its own shares.">
              <ModuleRow module={DRIVE} on={user.modules.includes("drive")} onChange={(on) => setModule("drive", on)} />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{children}</div>
    </section>
  );
}

function ModuleRow({
  module,
  on,
  disabled = false,
  onChange,
}: {
  module: ModuleInfo;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-4 rounded-lg border border-border px-4 py-3.5",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium">{module.label}</span>
        <span className="block text-[12.5px] text-muted-foreground">{module.hint}</span>
      </span>
      <Switch checked={on} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}
