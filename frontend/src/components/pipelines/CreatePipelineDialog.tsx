"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreatePipeline, usePipelineStagesQuery } from "@/hooks/use-pipelines";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialStageId?: number | null;
};

export function CreatePipelineDialog({
  open,
  onOpenChange,
  initialStageId,
}: Props) {
  const stagesQuery = usePipelineStagesQuery();
  const createPipeline = useCreatePipeline();

  // Map of stage id (stringified) → name, needed by base-ui's <SelectValue />
  // to render the selected option's label instead of the raw value.
  const stageItems: Record<string, string> = {};
  for (const s of stagesQuery.data ?? []) {
    stageItems[String(s.id)] = s.name;
  }

  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [description, setDescription] = useState("");
  const [stageId, setStageId] = useState<number | null>(initialStageId ?? null);

  function reset() {
    setTitle("");
    setCounterparty("");
    setDescription("");
    setStageId(initialStageId ?? null);
  }

  function handleSubmit() {
    if (!title.trim()) return;
    createPipeline.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        counterparty: counterparty.trim() || undefined,
        stage_id:
          stageId ??
          (stagesQuery.data?.[0]?.id as number | undefined) ??
          undefined,
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">
              Title
            </label>
            <Input
              autoFocus
              placeholder="e.g. Open Acme Bank account"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">
              Counterparty
            </label>
            <Input
              placeholder="e.g. Acme Bank"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">
              Stage
            </label>
            <Select
              value={stageId != null ? String(stageId) : ""}
              onValueChange={(v) => setStageId(v ? Number(v) : null)}
              items={stageItems}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="First stage" />
              </SelectTrigger>
              <SelectContent>
                {(stagesQuery.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">
              Description
            </label>
            <Textarea
              rows={3}
              placeholder="Background context — what this pipeline is about"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || createPipeline.isPending}
          >
            {createPipeline.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
