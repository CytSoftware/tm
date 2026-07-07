"use client";

/**
 * Create / edit dialog for a bet. Shared by /bets (single, known project)
 * and the home dashboard (project picked inside the dialog — the "new
 * period, place your bets" flow).
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/ColorPicker";
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
import { Textarea } from "@/components/ui/textarea";
import { useCreateBet, useUpdateBet } from "@/hooks/use-bets";
import { periodLabel } from "@/lib/periods";
import type { Bet, Project } from "@/lib/types";

export function BetFormDialog({
  projects,
  initialProjectId,
  period,
  bet,
  onClose,
}: {
  /** Candidate projects. One entry (or an edit) hides the picker. */
  projects: Project[];
  initialProjectId?: number | null;
  /** ISO period start the caller is currently showing — new bets land there. */
  period: string;
  /** Existing bet when editing; null when creating. */
  bet: Bet | null;
  onClose: () => void;
}) {
  const createBet = useCreateBet();
  const updateBet = useUpdateBet();
  const [projectId, setProjectId] = useState<number | null>(
    bet?.project ?? initialProjectId ?? projects[0]?.id ?? null,
  );
  const [name, setName] = useState(bet?.name ?? "");
  const [description, setDescription] = useState(bet?.description ?? "");
  const [color, setColor] = useState(bet?.color ?? "#6366f1");
  const saving = createBet.isPending || updateBet.isPending;
  const showProjectPicker = !bet && projects.length > 1;

  async function submit() {
    if (!name.trim() || projectId == null) return;
    if (bet) {
      await updateBet.mutateAsync({
        id: bet.id,
        name: name.trim(),
        description,
        color,
      });
    } else {
      await createBet.mutateAsync({
        project: projectId,
        name: name.trim(),
        description,
        color,
        period_start: period,
      });
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {bet
              ? `Edit bet — ${bet.name}`
              : `New bet · ${periodLabel(period)}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {showProjectPicker && (
            <Select
              value={projectId != null ? String(projectId) : ""}
              onValueChange={(v) => setProjectId(v === "" ? null : Number(v))}
              items={
                Object.fromEntries(
                  projects.map((p) => [String(p.id), p.name]),
                ) as Record<string, React.ReactNode>
              }
            >
              <SelectTrigger className="h-8 w-full text-[12px]">
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: p.color }}
                      />
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bet name — the wager in one line"
            autoFocus
            className="text-[13px]"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Target and kill criteria — what does won look like, when do you fold?"
            rows={4}
            className="text-[12px]"
          />
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={saving || !name.trim() || projectId == null}
          >
            {saving ? "Saving…" : bet ? "Save" : "Create bet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
