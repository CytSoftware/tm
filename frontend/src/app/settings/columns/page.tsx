"use client";

/**
 * Global staleness settings page.
 *
 * Thresholds are applied uniformly across all projects: a task is "yellow"
 * once it has sat in a column longer than ``yellow_days``, and "red" past
 * ``red_days``. Columns flagged ``is_done=True`` never trigger staleness
 * regardless of configuration, so we don't offer a row for them here.
 *
 * Per-column names are gathered from all non-done columns currently in the
 * DB; the form lets the user tune yellow/red for each (or blank them out to
 * disable that tier).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectColumnSettings, useColumnDrafts } from "@/components/project/ProjectColumns";
import { apiFetch } from "@/lib/api";
import { useProjectsQuery } from "@/hooks/use-projects";
import type { Project, StalenessSettings } from "@/lib/types";

const STALENESS_KEY = ["staleness-settings"] as const;

type ThresholdMap = Record<
  string,
  { yellow_days: string; red_days: string }
>;

export default function StalenessSettingsPage() {
  const qc = useQueryClient();

  const projectsQuery = useProjectsQuery();
  const settingsQuery = useQuery({
    queryKey: STALENESS_KEY,
    queryFn: () => apiFetch<StalenessSettings>("/api/settings/staleness/"),
  });

  const columnNames = useMemo(() => {
    const projects: Project[] = projectsQuery.data?.results ?? [];
    const names = new Set<string>();
    // Include every known non-done column name from every project.
    for (const p of projects) {
      for (const c of p.columns) {
        if (!c.is_done && c.kind !== "cancelled") names.add(c.name);
      }
    }
    // Also keep any column the saved config mentions, even if no project
    // currently has a column with that name (e.g. renamed columns). That
    // way the user can still edit/delete the stale rule.
    const saved = settingsQuery.data?.thresholds ?? {};
    for (const name of Object.keys(saved)) {
      names.add(name);
    }
    return Array.from(names).sort();
  }, [projectsQuery.data, settingsQuery.data]);

  if (settingsQuery.isLoading || projectsQuery.isLoading) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
        <p className="text-[14px] text-muted-foreground">
          Couldn&apos;t load staleness settings.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<a href="/board" />}
        >
          Back to board
        </Button>
      </div>
    );
  }

  return (
    <StalenessForm
      key={settingsQuery.data.updated_at}
      data={settingsQuery.data}
      columnNames={columnNames}
      onSaved={() =>
        qc.invalidateQueries({ queryKey: STALENESS_KEY })
      }
    />
  );
}

function StalenessForm({
  data,
  columnNames,
  onSaved,
}: {
  data: StalenessSettings;
  columnNames: string[];
  onSaved: () => void;
}) {
  const qc = useQueryClient();

  const [values, setValues] = useState<ThresholdMap>(() =>
    thresholdsToForm(data.thresholds, columnNames),
  );

  const saveMutation = useMutation({
    mutationFn: async (payload: StalenessSettings["thresholds"]) =>
      apiFetch<{ thresholds: StalenessSettings["thresholds"] }>(
        "/api/settings/staleness/",
        { method: "PATCH", body: { thresholds: payload } },
      ),
    onSuccess: () => {
      // The derived `staleness` on every task depends on these settings, so
      // invalidate all task queries too.
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onSaved();
    },
  });

  function setRow(
    name: string,
    field: "yellow_days" | "red_days",
    value: string,
  ) {
    setValues((prev) => ({
      ...prev,
      [name]: { ...prev[name], [field]: value },
    }));
  }

  const columnDrafts = useColumnDrafts();

  // One Save for the page: column renames/types and staleness thresholds.
  function handleSave() {
    if (columnDrafts.dirty) void columnDrafts.save();
    saveMutation.mutate(formToThresholds(values));
  }

  function resetToDefaults() {
    setValues(thresholdsToForm(data.defaults, columnNames));
  }

  const saving = saveMutation.isPending || columnDrafts.isPending;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        <header className="sticky top-0 z-10 -mx-6 -mt-8 px-6 pt-8 pb-3 flex items-center gap-3 bg-background">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight">
              Columns
            </h1>
            <p className="text-[12px] text-muted-foreground">
              Manage each project’s columns and task staleness thresholds.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {saveMutation.isError && (
              <span className="text-[12px] text-destructive">
                Couldn&apos;t save. Try again.
              </span>
            )}
            {columnDrafts.dirty && !saving && (
              <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
            )}
            {saveMutation.isSuccess && !saving && !columnDrafts.dirty && (
              <span className="text-[12px] text-muted-foreground">Saved.</span>
            )}
            <Button size="sm" onClick={handleSave} disabled={saving || columnDrafts.invalid}>
              <Save className="size-3.5" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </header>

        <ProjectColumnSettings drafts={columnDrafts} />
        <h2 className="text-sm font-medium">Staleness thresholds</h2>
        <p className="text-xs text-muted-foreground">Applied across projects by column name. Done and Cancelled columns are excluded.</p>
        <section className="rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[1fr_90px_90px] max-lg:hidden items-center gap-3 px-4 py-2.5 border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Column</span>
            <span>Yellow (days)</span>
            <span>Red (days)</span>
          </div>
          {columnNames.length === 0 && (
            <p className="px-4 py-6 text-[12px] text-muted-foreground text-center">
              No columns configured yet. Create a project first.
            </p>
          )}
          {columnNames.map((name) => {
            const row = values[name] ?? { yellow_days: "", red_days: "" };
            return (
              <div
                key={name}
                className="grid grid-cols-[1fr_90px_90px] max-lg:grid-cols-2 items-center gap-3 px-4 py-2 border-b border-border/30 last:border-0"
              >
                <span className="text-[13px] font-medium truncate max-lg:col-span-2">
                  {name}
                </span>
                <Input
                  type="number"
                  min={0}
                  value={row.yellow_days}
                  onChange={(e) =>
                    setRow(name, "yellow_days", e.target.value)
                  }
                  placeholder="Yellow"
                  aria-label={`${name} — yellow after (days)`}
                  className="h-8 text-[12px] max-lg:placeholder:text-muted-foreground/60"
                />
                <Input
                  type="number"
                  min={0}
                  value={row.red_days}
                  onChange={(e) => setRow(name, "red_days", e.target.value)}
                  placeholder="Red"
                  aria-label={`${name} — red after (days)`}
                  className="h-8 text-[12px]"
                />
              </div>
            );
          })}
        </section>

        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={resetToDefaults}
            className="text-muted-foreground"
          >
            <RotateCcw className="size-3.5" />
            Reset to defaults
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Convert the server's threshold map into the form's editable shape. */
function thresholdsToForm(
  src: StalenessSettings["thresholds"],
  columnNames: string[],
): ThresholdMap {
  const out: ThresholdMap = {};
  for (const name of columnNames) {
    const rules = src[name] ?? {};
    out[name] = {
      yellow_days:
        rules.yellow_days != null ? String(rules.yellow_days) : "",
      red_days: rules.red_days != null ? String(rules.red_days) : "",
    };
  }
  return out;
}

/** Convert the form's editable shape into the API payload. */
function formToThresholds(
  values: ThresholdMap,
): StalenessSettings["thresholds"] {
  const out: StalenessSettings["thresholds"] = {};
  for (const [name, row] of Object.entries(values)) {
    const rules: { yellow_days?: number; red_days?: number } = {};
    if (row.yellow_days.trim() !== "") {
      const n = Number(row.yellow_days);
      if (Number.isFinite(n) && n >= 0) rules.yellow_days = Math.floor(n);
    }
    if (row.red_days.trim() !== "") {
      const n = Number(row.red_days);
      if (Number.isFinite(n) && n >= 0) rules.red_days = Math.floor(n);
    }
    // Skip rows where both fields are empty so we don't persist empty dicts.
    if ("yellow_days" in rules || "red_days" in rules) {
      out[name] = rules;
    }
  }
  return out;
}
