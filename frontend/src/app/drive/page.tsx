"use client";

/**
 * Drive — a Backblaze B2 file browser + in-browser viewer (the company drive).
 * B2 is the source of truth; there are no local models. Uploads/downloads use
 * presigned URLs; the viewer renders images/PDF/media/text inline via an
 * inline-disposition presigned GET (Office docs stay download-only).
 *
 * Layout invariant (see CLAUDE.md): immediate child of the app shell, so the
 * root is ``h-full flex`` and every scroll surface carries ``min-h-0``.
 */

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  Home,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { type DriveItem, MoveDialog, ShareDialog } from "@/components/drive/DriveDialogs";
import {
  type DriveFile,
  INBOX,
  downloadObject,
  getViewUrl,
  isWritable,
  useCreateFolder,
  useDeleteObject,
  useDriveList,
  useUploadFile,
} from "@/hooks/use-drive";
import { MasterDetail } from "@/components/layout/MasterDetail";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const TEXT_CAP = 1_500_000; // 1.5 MB — inline-preview text under this

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
  if (prefix === INBOX) return "To be organized";
  const parts = prefix.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || prefix;
}

/** Project and category folders are fixed; anything deeper can move. */
function isMovableFolder(folder: string): boolean {
  return folder !== INBOX && isWritable(folder.replace(/[^/]+\/$/, ""));
}

type Kind = "image" | "pdf" | "video" | "audio" | "text" | "other";

function kindOf(name: string): Kind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"].includes(ext))
    return "image";
  if (ext === "pdf") return "pdf";
  if (["mp4", "webm", "mov", "ogv", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
  if (
    [
      "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "log",
      "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "sh", "sql",
      "toml", "ini", "conf", "env",
    ].includes(ext)
  )
    return "text";
  return "other";
}

function Center({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-full grid place-items-center p-6 text-[13px] text-muted-foreground text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

function FilePreview({ file }: { file: DriveFile }) {
  const kind = kindOf(file.name);

  const urlQ = useQuery({
    queryKey: ["drive", "view", file.key],
    queryFn: () => getViewUrl(file.key),
    staleTime: 50 * 60_000, // presigned URLs live ~1h
  });
  const url = urlQ.data;

  const textQ = useQuery({
    queryKey: ["drive", "text", file.key],
    queryFn: async () => {
      const r = await fetch(url as string);
      if (!r.ok) throw new Error(`Storage returned ${r.status}`);
      return r.text();
    },
    enabled: kind === "text" && !!url && file.size <= TEXT_CAP,
    staleTime: 50 * 60_000,
  });

  if (kind === "other")
    return <Center>No inline preview for this file type — use Download.</Center>;
  if (kind === "text" && file.size > TEXT_CAP)
    return <Center>File too large to preview inline — use Download.</Center>;
  if (urlQ.isLoading) return <Center>Loading…</Center>;
  if (urlQ.isError || !url)
    return <Center className="text-destructive">Couldn&apos;t load preview.</Center>;

  if (kind === "image")
    return (
      <div className="h-full overflow-auto p-6 grid place-items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={file.name} className="max-w-full object-contain" />
      </div>
    );
  if (kind === "pdf")
    return <iframe src={url} title={file.name} className="w-full h-full border-0" />;
  if (kind === "video")
    return (
      <div className="h-full grid place-items-center p-6">
        <video src={url} controls className="max-w-full max-h-full" />
      </div>
    );
  if (kind === "audio")
    return (
      <div className="h-full grid place-items-center p-6">
        <audio src={url} controls />
      </div>
    );

  // text
  if (textQ.isLoading) return <Center>Loading…</Center>;
  if (textQ.isError)
    return <Center className="text-destructive">Couldn&apos;t load file contents.</Center>;
  return (
    <pre className="h-full overflow-auto p-3 lg:p-6 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words">
      {textQ.data}
    </pre>
  );
}

export default function DrivePage() {
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState<DriveFile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [moving, setMoving] = useState<DriveItem | null>(null);
  const [sharing, setSharing] = useState<DriveItem | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Multi-file upload: one file at a time, so progress and failures are per file.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<{ name: string; error: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const { data: me } = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const staff = !!me?.is_staff;
  const list = useDriveList(prefix, staff && showSystem);
  const upload = useUploadFile();
  const newFolder = useCreateFolder();
  const del = useDeleteObject();

  const segments = prefix.replace(/\/$/, "").split("/").filter(Boolean);
  // Above a category (root, a project) is locked: uploads go to the inbox.
  const writable = isWritable(prefix);

  function goTo(index: number) {
    setSelected(null);
    setPrefix(index < 0 ? "" : segments.slice(0, index + 1).join("/") + "/");
  }

  function openFolder(folder: string) {
    setSelected(null);
    setPrefix(folder);
  }

  async function uploadAll(files: File[]) {
    if (!files.length || progress) return;
    const folder = writable ? prefix : INBOX;
    const errors: { name: string; error: string }[] = [];
    setFailed([]);
    setProgress({ done: 0, total: files.length });
    for (const [i, file] of files.entries()) {
      try {
        await upload.mutateAsync({ file, folder });
      } catch (e) {
        errors.push({ name: file.name, error: e instanceof Error ? e.message : "Upload failed." });
      }
      setProgress({ done: i + 1, total: files.length });
    }
    setProgress(null);
    setFailed(errors);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void uploadAll(files);
  }

  // Desktop drag-and-drop from the OS; touch devices use the Upload button.
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    void uploadAll(Array.from(e.dataTransfer.files));
  }

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragOver(true);
  }

  function onNewFolder() {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    setActionError(null);
    newFolder.mutate(
      { parent: prefix, name },
      {
        onError: (e) =>
          setActionError(e instanceof Error ? e.message : "Couldn't create folder."),
      },
    );
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
    list.data && list.data.folders.length === 0 && list.data.files.length === 0;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header / breadcrumb + upload */}
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
        <div className="ml-auto shrink-0 flex items-center gap-2">
          {staff && (
            <label className="hidden sm:flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Switch
                checked={showSystem}
                onCheckedChange={(on) => setShowSystem(!!on)}
              />
              System files
            </label>
          )}
          {writable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={newFolder.isPending}
              onClick={onNewFolder}
            >
              <FolderPlus className="size-3.5" />
              <span className="max-sm:hidden">New folder</span>
            </Button>
          )}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={onPick} />
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={progress != null}
            onClick={() => fileRef.current?.click()}
            title={writable ? undefined : "Not inside a category — it goes to To be organized"}
          >
            <Upload className="size-3.5" />
            {progress
              ? `Uploading ${Math.min(progress.done + 1, progress.total)}/${progress.total}…`
              : writable
                ? "Upload"
                : "Upload to To be organized"}
          </Button>
        </div>
      </header>

      {/* Body: file list (left) + preview (right) */}
      <MasterDetail
        className="flex-1"
        railWidth="w-80"
        hasSelection={selected != null}
        onBack={() => setSelected(null)}
        backLabel="Files"
        master={
          <div
            className={cn(
              "flex-1 min-h-0 overflow-y-auto",
              dragOver && "bg-accent/40 outline-2 -outline-offset-2 outline-dashed outline-ring",
            )}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
            }}
            onDrop={onDrop}
          >
            {dragOver && (
              <div className="px-4 py-2 text-[12px] text-muted-foreground border-b border-border/60">
                Drop to upload to {writable ? `/${prefix}` : "To be organized"}
              </div>
            )}
            {list.isLoading ? (
              <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
            ) : list.isError ? (
              <div className="p-4 text-[13px] text-destructive">
                {staff
                  ? `${(list.error as Error)?.message ?? "Failed to load."} — is Drive storage configured?`
                  : "You don't have access to this folder."}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {list.data!.folders.map((f) => (
                  <li key={`folder:${f}`} className="group flex items-center hover:bg-accent/50">
                    <button
                      type="button"
                      onClick={() => openFolder(f)}
                      className={cn(
                        "flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 text-[13px] text-left",
                        list.data!.empty?.includes(f) && "text-muted-foreground/50",
                      )}
                      title={list.data!.empty?.includes(f) ? "Empty" : undefined}
                    >
                      <Folder className="size-4 shrink-0 opacity-60" />
                      <span className="truncate flex-1">{folderLabel(f)}</span>
                    </button>
                    <div className="flex items-center gap-0.5 pr-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 hover-none:opacity-100">
                      {staff && (
                        <button
                          type="button"
                          onClick={() => setSharing({ key: f, label: folderLabel(f) })}
                          className="tap-target size-6 grid place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label={`Share ${folderLabel(f)}`}
                        >
                          <Share2 className="size-3.5" />
                        </button>
                      )}
                      {isMovableFolder(f) && (
                        <button
                          type="button"
                          onClick={() => setMoving({ key: f, label: folderLabel(f) })}
                          className="tap-target size-6 grid place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label={`Move ${folderLabel(f)}`}
                        >
                          <FolderInput className="size-3.5" />
                        </button>
                      )}
                    </div>
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
            {failed.length > 0 && (
              <div className="p-3 text-[12px] text-destructive space-y-0.5">
                <p className="font-medium">
                  {failed.length} file{failed.length > 1 ? "s" : ""} didn&apos;t upload:
                </p>
                {failed.map((f) => (
                  <p key={f.name} className="truncate">
                    {f.name} — {f.error}
                  </p>
                ))}
              </div>
            )}
            {actionError && !selected && (
              <div className="p-3 text-[12px] text-destructive">{actionError}</div>
            )}
          </div>
        }
        detail={
          selected ? (
            <>
              <div className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-border/80">
                <FileIcon className="size-4 text-muted-foreground shrink-0" />
                <span className="text-[13px] font-medium truncate">
                  {selected.name}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {formatSize(selected.size)}
                </span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => onDownload(selected)}
                  >
                    <Download className="size-3.5" /> Download
                  </Button>
                  {staff && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => setSharing({ key: selected.key, label: selected.name })}
                    >
                      <Share2 className="size-3.5" /> Share
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => setMoving({ key: selected.key, label: selected.name })}
                    aria-label="Move file"
                  >
                    <FolderInput className="size-3.5" />
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
              </div>
              {actionError && (
                <div className="shrink-0 px-4 py-1.5 text-[12px] text-destructive border-b border-border/80">
                  {actionError}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <FilePreview file={selected} />
              </div>
            </>
          ) : (
            <div className="h-full grid place-items-center text-[13px] text-muted-foreground">
              Select a file to preview.
            </div>
          )
        }
      />
      <MoveDialog
        item={moving}
        onClose={(moved) => {
          // A moved file is no longer in this folder.
          if (moved && selected?.key === moving?.key) setSelected(null);
          setMoving(null);
        }}
      />
      <ShareDialog item={sharing} onClose={() => setSharing(null)} />
    </div>
  );
}
