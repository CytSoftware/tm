"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, ApiError } from "@/lib/api";
import { projectsKey } from "@/lib/query-keys";
import { useActiveProject } from "@/lib/active-project";
import type { Project } from "@/lib/types";

type Props = {
  onClose: () => void;
};

export function CreateProjectDialog({ onClose }: Props) {
  const qc = useQueryClient();
  const { setProjectId } = useActiveProject();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);

  // Auto-derive a prefix from the name until the user edits it themselves.
  const suggestedPrefix = useMemo(() => {
    if (prefixTouched) return prefix;
    const chars = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
    return chars.slice(0, 3) || "";
  }, [name, prefix, prefixTouched]);

  const mutation = useMutation({
    mutationFn: (payload: { name: string; prefix: string }) =>
      apiFetch<Project>("/api/projects/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: projectsKey() });
      setProjectId(project.id);
      onClose();
    },
  });

  function handleSubmit() {
    const finalPrefix = (prefixTouched ? prefix : suggestedPrefix).toUpperCase();
    if (!name.trim() || !finalPrefix) return;
    mutation.mutate({ name: name.trim(), prefix: finalPrefix });
  }

  const error = mutation.error;
  const errorMessage =
    error instanceof ApiError
      ? formatApiError(error)
      : error
        ? "Something went wrong."
        : null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-[420px] p-0 gap-0 flex flex-col"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            New project
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Projects own a task key prefix — e.g. <span className="font-mono">CYT-001</span>.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="px-5 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Name
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Internal Infra"
                autoFocus
                className="h-9 text-[13px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Key prefix
              </Label>
              <Input
                value={prefixTouched ? prefix : suggestedPrefix}
                onChange={(e) => {
                  setPrefixTouched(true);
                  setPrefix(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                  );
                }}
                placeholder="CYT"
                maxLength={8}
                className="h-9 text-[13px] font-mono tracking-widest uppercase"
              />
              <p className="text-[11px] text-muted-foreground">
                2–8 letters or digits. Must be unique across all projects.
              </p>
            </div>
            {errorMessage && (
              <p className="text-[12px] text-destructive">{errorMessage}</p>
            )}
          </div>
          <div className="shrink-0 px-5 py-3 border-t border-border/60 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                mutation.isPending ||
                !name.trim() ||
                !(prefixTouched ? prefix : suggestedPrefix)
              }
            >
              {mutation.isPending ? "Creating..." : "Create project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatApiError(err: ApiError): string {
  const payload = err.payload as
    | Record<string, string[] | string>
    | { detail?: string }
    | null;
  if (!payload) return err.message;
  if (typeof payload === "object" && "detail" in payload && payload.detail) {
    return String(payload.detail);
  }
  // DRF field errors: { prefix: ["project with this prefix already exists."] }
  if (typeof payload === "object") {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(payload)) {
      const str = Array.isArray(value) ? value.join(" ") : String(value);
      parts.push(`${field}: ${str}`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  return err.message;
}
