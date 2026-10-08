"use client";

/**
 * Drive dialogs: "Move to…" (a folder picker — the touch-friendly counterpart
 * to drag-and-drop, see CLAUDE.md) and "Share" (pick which non-staff users can
 * see a file or a whole folder).
 */

import { useState } from "react";
import { ChevronLeft, Folder } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  isWritable,
  useDriveList,
  useMoveObject,
  useSetShares,
  useShares,
} from "@/hooks/use-drive";

export type DriveItem = { key: string; label: string };

function parentOf(key: string): string {
  const trimmed = key.replace(/\/$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut < 0 ? "" : trimmed.slice(0, cut + 1);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function MoveDialog({
  item,
  onClose,
}: {
  item: DriveItem | null;
  onClose: (moved: boolean) => void;
}) {
  const [prefix, setPrefix] = useState("");
  const list = useDriveList(prefix);
  const move = useMoveObject();

  const isFolder = !!item?.key.endsWith("/");
  const canDrop =
    !!item &&
    isWritable(prefix) &&
    prefix !== parentOf(item.key) &&
    !(isFolder && prefix.startsWith(item.key));

  function close(moved = false) {
    setPrefix("");
    move.reset();
    onClose(moved);
  }

  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move “{item?.label}”</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-1 text-[12px] text-muted-foreground min-w-0">
          <button
            type="button"
            disabled={!prefix}
            onClick={() => setPrefix(parentOf(prefix))}
            className="tap-target size-6 grid place-items-center rounded hover:bg-accent disabled:opacity-40"
            aria-label="Up one folder"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="truncate">/{prefix}</span>
        </div>
        <ul className="h-64 overflow-y-auto rounded-md border border-border divide-y divide-border/60">
          {(list.data?.folders ?? [])
            .filter((f) => f !== item?.key)
            .map((f) => (
              <li key={f}>
                <button
                  type="button"
                  onClick={() => setPrefix(f)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-accent/50 text-left",
                    list.data?.empty?.includes(f) && "text-muted-foreground/50",
                  )}
                >
                  <Folder className="size-4 shrink-0 opacity-60" />
                  <span className="truncate">{f.slice(prefix.length).replace(/\/$/, "")}</span>
                </button>
              </li>
            ))}
          {list.data && list.data.folders.length === 0 && (
            <li className="p-3 text-[12px] text-muted-foreground">No folders here.</li>
          )}
        </ul>
        {!isWritable(prefix) && (
          <p className="text-[12px] text-muted-foreground">
            Open a category (e.g. sales) or To be organized to move here.
          </p>
        )}
        {move.isError && (
          <p className="text-[12px] text-destructive">{errorText(move.error)}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close()}>
            Cancel
          </Button>
          <Button
            disabled={!canDrop || move.isPending}
            onClick={() =>
              item &&
              move.mutate({ key: item.key, to: prefix }, { onSuccess: () => close(true) })
            }
          >
            {move.isPending ? "Moving…" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShareDialog({
  item,
  onClose,
}: {
  item: DriveItem | null;
  onClose: () => void;
}) {
  const shares = useShares(item?.key ?? null);
  const save = useSetShares();
  // Local edits over the server's list; null = untouched.
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const selected = picked ?? new Set(shares.data?.shared_with ?? []);

  function close() {
    setPicked(null);
    save.reset();
    onClose();
  }

  function toggle(id: number, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  }

  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Share “{item?.label}”</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          {item?.key.endsWith("/")
            ? "These people can open this folder and everything inside it."
            : "These people can open this file."}{" "}
          Staff already see everything.
        </p>
        <ul className="max-h-64 overflow-y-auto space-y-1">
          {shares.isLoading && (
            <li className="text-[12px] text-muted-foreground">Loading…</li>
          )}
          {shares.data?.users.map((u) => (
            <li key={u.id}>
              <label className="flex items-center gap-2.5 rounded px-1 py-1.5 text-[13px] hover:bg-accent/50 cursor-pointer">
                <Checkbox
                  checked={selected.has(u.id)}
                  onCheckedChange={(on) => toggle(u.id, !!on)}
                />
                <span className="truncate">{u.name || u.username}</span>
                {u.name && (
                  <span className="text-[11px] text-muted-foreground truncate">
                    {u.username}
                  </span>
                )}
              </label>
            </li>
          ))}
          {shares.data && shares.data.users.length === 0 && (
            <li className="text-[12px] text-muted-foreground">
              No non-staff users yet. Add them in the Django admin.
            </li>
          )}
        </ul>
        {save.isError && (
          <p className="text-[12px] text-destructive">{errorText(save.error)}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close()}>
            Cancel
          </Button>
          <Button
            disabled={!item || save.isPending || picked == null}
            onClick={() =>
              item &&
              save.mutate(
                { key: item.key, user_ids: [...selected] },
                { onSuccess: close },
              )
            }
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
