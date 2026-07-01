"use client";

/**
 * Drive — a Backblaze B2 file browser (the company drive), backed by the
 * cyt-drive bucket. B2 is the source of truth; there are no local models.
 *
 * Layout invariant (see CLAUDE.md "Frontend scroll invariant"): this page is
 * the immediate child of the app shell, so the root is ``h-full flex`` and
 * every flex child that hosts a scroll area carries ``min-h-0``.
 */

import { useRef, useState } from "react";
import {
  Download,
  File as FileIcon,
  Folder,
  HardDrive,
  Home,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  type DriveFile,
  downloadObject,
  useDeleteObject,
  useDriveList,
  useUploadFile,
} from "@/hooks/use-drive";
import { cn } from "@/lib/utils";

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function folderLabel(prefix: string): string {
  const parts = prefix.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || prefix;
}

export default function DrivePage() {
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState<DriveFile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useDriveList(prefix);
  const upload = useUploadFile(prefix);
  const del = useDeleteObject();

  const segments = prefix.replace(/\/$/, "").split("/").filter(Boolean);

  function goTo(index: number) {
    setSelected(null);
    setPrefix(index < 0 ? "" : segments.slice(0, index + 1).join("/") + "/");
  }

  function openFolder(folder: string) {
    setSelected(null);
    setPrefix(folder); // full relative prefix, already ends with "/"
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) upload.mutate(file);
  }

  async function onDownload(f: DriveFile) {
    setActionError(null);
    try {
      await downloadObject(f.key, f.name);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Download failed.");
    }
  }

  function onDelete(f: DriveFile) {
    if (confirm(`Delete "${f.name}"? This is permanent.`)) {
      setActionError(null);
      del.mutate(f.key, {
        onSuccess: () => setSelected((s) => (s?.key === f.key ? null : s)),
        onError: (e) =>
          setActionError(e instanceof Error ? e.message : "Delete failed."),
      });
    }
  }

  const empty =
    list.data &&
    list.data.folders.length === 0 &&
    list.data.files.length === 0;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header / breadcrumb */}
      <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-border/80">
        <HardDrive className="size-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-1 text-[13px] min-w-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => goTo(-1)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground shrink-0"
          >
            <Home className="size-3.5" /> Drive
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              <span className="text-muted-foreground/50">/</span>
              <button
                type="button"
                onClick={() => goTo(i)}
                className={cn(
                  "hover:text-foreground truncate max-w-[12rem]",
                  i === segments.length - 1
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>
        <div className="ml-auto shrink-0">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={onPick}
          />
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-3.5" />
            {upload.isPending ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </header>

      {/* Body: file list + optional detail pane */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
          {list.isLoading ? (
            <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>
          ) : list.isError ? (
            <div className="p-6 text-[13px] text-destructive">
              {(list.error as Error)?.message ?? "Failed to load."} — is Drive
              storage configured?
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {list.data!.folders.map((f) => (
                <li key={`folder:${f}`}>
                  <button
                    type="button"
                    onClick={() => openFolder(f)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-accent/50 text-left"
                  >
                    <Folder className="size-4 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1">{folderLabel(f)}</span>
                    <span className="text-muted-foreground/50 text-xs shrink-0">
                      folder
                    </span>
                  </button>
                </li>
              ))}
              {list.data!.files.map((f) => (
                <li key={`file:${f.key}`}>
                  <button
                    type="button"
                    onClick={() => setSelected(f)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-accent/50 text-left",
                      selected?.key === f.key && "bg-accent",
                    )}
                  >
                    <FileIcon className="size-4 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1">{f.name}</span>
                    <span className="text-muted-foreground/60 text-xs tabular-nums shrink-0">
                      {formatSize(f.size)}
                    </span>
                  </button>
                </li>
              ))}
              {empty && (
                <li className="p-6 text-[13px] text-muted-foreground">
                  This folder is empty.
                </li>
              )}
            </ul>
          )}
          {upload.isError && (
            <div className="p-3 text-[12px] text-destructive">
              {(upload.error as Error)?.message}
            </div>
          )}
        </div>

        {selected && (
          <aside className="w-80 shrink-0 border-l border-border/80 min-h-0 overflow-y-auto p-4 space-y-4">
            <div className="flex items-start gap-3">
              <FileIcon className="size-8 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="text-[14px] font-medium break-words">
                  {selected.name}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {formatSize(selected.size)}
                </div>
              </div>
            </div>
            <dl className="text-[12px] space-y-1.5">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground shrink-0">Path</dt>
                <dd className="truncate max-w-[12rem] text-right">
                  {selected.key}
                </dd>
              </div>
              {selected.last_modified && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground shrink-0">Modified</dt>
                  <dd className="text-right">
                    {new Date(selected.last_modified).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 flex-1"
                onClick={() => onDownload(selected)}
              >
                <Download className="size-3.5" /> Download
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-destructive"
                disabled={del.isPending}
                onClick={() => onDelete(selected)}
                aria-label="Delete file"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {actionError && (
              <div className="text-[12px] text-destructive">{actionError}</div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
