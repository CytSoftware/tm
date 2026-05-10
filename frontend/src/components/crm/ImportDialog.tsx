"use client";

/**
 * Three-step spreadsheet-import wizard (CSV or XLSX).
 *
 *   1. Upload         — pick a CSV or XLSX file. The browser drives the
 *                       multipart upload to /api/contacts/import-preview/,
 *                       which returns a token + format + sample + a
 *                       header→target suggestion map.
 *   2. Map columns    — user reviews and edits the target for each source
 *                       column. Targets are Contact field names plus the
 *                       special values "labels", "websites", "socials.*",
 *                       and "[ignore]".
 *   3. Apply          — POST mapping+token to /api/contacts/import-apply/
 *                       and show the result (created/updated/skipped/errors).
 */

import { useMemo, useState } from "react";
import { ArrowLeft, FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useContactImportApply,
  useContactImportPreview,
} from "@/hooks/use-contacts";
import type {
  ContactImportPreview,
  ContactImportResult,
} from "@/lib/types";

type Step = "upload" | "map" | "result";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const TARGET_LABELS: Record<string, string> = {
  "[ignore]": "— Ignore this column —",
  company: "Company",
  first_name: "First name",
  last_name: "Last name",
  industry: "Industry",
  job_title: "Job title",
  email: "Email",
  phone: "Phone",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  city: "City",
  region: "Region / State",
  postal_code: "Postal code",
  country: "Country",
  websites: "Websites (comma-separated)",
  "socials.linkedin": "LinkedIn URL",
  "socials.twitter": "Twitter / X URL",
  "socials.facebook": "Facebook URL",
  "socials.instagram": "Instagram URL",
  labels: "Labels (comma-separated)",
  notes: "Notes",
};

export function ImportDialog({ open, onOpenChange }: Props) {
  const previewMutation = useContactImportPreview();
  const applyMutation = useContactImportApply();

  const [step, setStep] = useState<Step>("upload");
  const [preview, setPreview] = useState<ContactImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dedupe, setDedupe] = useState<"email" | "name+company" | "none">(
    "email",
  );
  const [onConflict, setOnConflict] = useState<"skip" | "update">("skip");
  const [result, setResult] = useState<ContactImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("upload");
    setPreview(null);
    setMapping({});
    setDedupe("email");
    setOnConflict("skip");
    setResult(null);
    setError(null);
    previewMutation.reset();
    applyMutation.reset();
  }

  function handleFile(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    previewMutation.mutate(file, {
      onSuccess: (p) => {
        setPreview(p);
        setMapping(p.suggested_mapping);
        setStep("map");
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : "Upload failed.");
      },
    });
  }

  function handleApply() {
    if (!preview) return;
    setError(null);
    applyMutation.mutate(
      {
        token: preview.token,
        mapping,
        dedupe,
        on_conflict: onConflict,
      },
      {
        onSuccess: (r) => {
          setResult(r);
          setStep("result");
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : "Import failed.");
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step !== "upload" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() =>
                  setStep(step === "result" ? "map" : "upload")
                }
                aria-label="Back"
              >
                <ArrowLeft className="size-3.5" />
              </Button>
            )}
            Import contacts (CSV or XLSX) from CSV
          </DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <UploadStep
            onPick={handleFile}
            loading={previewMutation.isPending}
            error={error}
          />
        )}

        {step === "map" && preview && (
          <MapStep
            preview={preview}
            mapping={mapping}
            onMappingChange={setMapping}
            dedupe={dedupe}
            onDedupeChange={setDedupe}
            onConflict={onConflict}
            onConflictChange={setOnConflict}
          />
        )}

        {step === "result" && result && <ResultStep result={result} />}

        {error && step !== "upload" && (
          <div className="text-[12px] text-destructive">{error}</div>
        )}

        <DialogFooter>
          {step === "upload" && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          {step === "map" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button onClick={handleApply} disabled={applyMutation.isPending}>
                {applyMutation.isPending ? "Importing…" : "Import"}
              </Button>
            </>
          )}
          {step === "result" && (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadStep({
  onPick,
  loading,
  error,
}: {
  onPick: (file: File | null) => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-3 py-4">
      <p className="text-[13px] text-muted-foreground">
        Upload a CSV or Excel (.xlsx) file. The next step lets you map each
        column to a contact field — even if your headers don&apos;t match
        ours.
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-border/80 rounded-lg py-10 cursor-pointer hover:bg-muted/40 transition-colors">
        <FileUp className="size-8 text-muted-foreground mb-2" />
        <div className="text-[13px] font-medium">Click to choose a file</div>
        <div className="text-[11px] text-muted-foreground">
          .csv or .xlsx · up to 10k rows · 20 MB
        </div>
        <Input
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          disabled={loading}
        />
      </label>
      {loading && (
        <div className="text-[12px] text-muted-foreground">Parsing…</div>
      )}
      {error && <div className="text-[12px] text-destructive">{error}</div>}
    </div>
  );
}

function MapStep({
  preview,
  mapping,
  onMappingChange,
  dedupe,
  onDedupeChange,
  onConflict,
  onConflictChange,
}: {
  preview: ContactImportPreview;
  mapping: Record<string, string>;
  onMappingChange: (m: Record<string, string>) => void;
  dedupe: "email" | "name+company" | "none";
  onDedupeChange: (v: "email" | "name+company" | "none") => void;
  onConflict: "skip" | "update";
  onConflictChange: (v: "skip" | "update") => void;
}) {
  const targetItems = useMemo(() => {
    const out: Record<string, string> = {};
    for (const t of preview.valid_targets) {
      out[t] = TARGET_LABELS[t] ?? t;
    }
    return out;
  }, [preview.valid_targets]);

  const mappedCount = preview.headers.filter(
    (h) => mapping[h] && mapping[h] !== "[ignore]",
  ).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">
          {preview.row_count.toLocaleString()} rows ·{" "}
          {preview.headers.length} columns ·{" "}
          <strong>{mappedCount}</strong> mapped
        </span>
        <span className="text-muted-foreground">
          {preview.format === "xlsx" ? (
            <>format: <code className="font-mono">xlsx</code></>
          ) : (
            <>delimiter: <code className="font-mono">{preview.delimiter}</code></>
          )}
        </span>
      </div>

      <div className="rounded-md border border-border/60 max-h-72 overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-muted/40">
            <tr className="border-b border-border/60">
              <th className="text-left p-2 font-medium w-1/3">CSV column</th>
              <th className="text-left p-2 font-medium w-1/3">Maps to</th>
              <th className="text-left p-2 font-medium w-1/3">Sample</th>
            </tr>
          </thead>
          <tbody>
            {preview.headers.map((h, i) => {
              const sampleValue = (preview.sample_rows[0]?.[i] ?? "")
                .toString()
                .slice(0, 60);
              const target = mapping[h] ?? "[ignore]";
              return (
                <tr key={h} className="border-b border-border/40">
                  <td className="p-2 font-mono text-[11px] truncate max-w-[200px]">
                    {h || <em className="text-muted-foreground">(empty)</em>}
                  </td>
                  <td className="p-2">
                    <Select
                      value={target}
                      onValueChange={(v) =>
                        onMappingChange({
                          ...mapping,
                          [h]: typeof v === "string" ? v : "[ignore]",
                        })
                      }
                      items={targetItems}
                    >
                      <SelectTrigger className="w-full h-7 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {preview.valid_targets.map((t) => (
                          <SelectItem key={t} value={t}>
                            {TARGET_LABELS[t] ?? t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-2 text-muted-foreground truncate max-w-[200px]">
                    {sampleValue ||
                      (preview.row_count > 0 ? (
                        <em>—</em>
                      ) : (
                        <em>no rows</em>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-3 pt-1">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            Detect duplicates by
          </label>
          <Select
            value={dedupe}
            onValueChange={(v) =>
              onDedupeChange(v as "email" | "name+company" | "none")
            }
            items={{
              email: "Email (recommended)",
              "name+company": "First + last + company",
              none: "Don't dedupe — always create",
            }}
          >
            <SelectTrigger className="w-full h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email (recommended)</SelectItem>
              <SelectItem value="name+company">
                First + last + company
              </SelectItem>
              <SelectItem value="none">
                Don&apos;t dedupe — always create
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            On conflict
          </label>
          <Select
            value={onConflict}
            onValueChange={(v) => onConflictChange(v as "skip" | "update")}
            items={{
              skip: "Skip duplicates",
              update: "Fill blanks on existing rows",
            }}
          >
            <SelectTrigger className="w-full h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip duplicates</SelectItem>
              <SelectItem value="update">
                Fill blanks on existing rows
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function ResultStep({ result }: { result: ContactImportResult }) {
  return (
    <div className="space-y-3 py-2">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Created" value={result.created} tone="success" />
        <Stat label="Updated" value={result.updated} tone="info" />
        <Stat label="Skipped" value={result.skipped} tone="muted" />
      </div>
      {result.errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1 max-h-48 overflow-y-auto">
          <div className="text-[12px] font-medium text-destructive">
            {result.errors.length} row{result.errors.length === 1 ? "" : "s"}{" "}
            failed
          </div>
          <ul className="text-[11px] space-y-0.5 font-mono">
            {result.errors.slice(0, 50).map((e, i) => (
              <li key={i} className="truncate">
                row {e.row}: {e.reason}
              </li>
            ))}
            {result.errors.length > 50 && (
              <li className="text-muted-foreground italic">
                …and {result.errors.length - 50} more
              </li>
            )}
          </ul>
        </div>
      )}
      <div className="text-[12px] text-muted-foreground pt-1">
        Click <strong>Done</strong> to refresh the contacts table.
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "info" | "muted";
}) {
  const colorMap = {
    success: "text-emerald-600 dark:text-emerald-400",
    info: "text-blue-600 dark:text-blue-400",
    muted: "text-muted-foreground",
  };
  return (
    <div className="rounded-md border border-border/60 p-3 text-center">
      <div className={`text-2xl font-semibold ${colorMap[tone]}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
}
