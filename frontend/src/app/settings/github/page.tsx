"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, ApiError } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import type { Me } from "@/lib/types";

export default function GitHubSettingsPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (username: string) => apiFetch<Me>("/api/auth/me/", {
      method: "PATCH", body: { github_username: username },
    }),
    onSuccess: (user) => {
      queryClient.setQueryData(meKey(), user);
      setDraft(null);
      toast.success(user.github_username ? "GitHub username saved" : "GitHub mapping removed");
    },
  });
  const username = draft ?? me.data?.github_username ?? "";
  const error = save.error instanceof ApiError
    ? (save.error.payload as { github_username?: string[] })?.github_username?.[0]
    : null;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-6">
      <div className="max-w-lg space-y-5">
        <div>
          <h1 className="text-lg font-semibold">GitHub</h1>
          <p className="mt-1 text-sm text-muted-foreground">Map your GitHub username to your CytHQ account for PR review requests.</p>
        </div>
        {me.isPending ? <p role="status">Loading…</p> : me.isError || !me.data ? (
          <div role="alert">Couldn’t load your profile. <Button variant="link" onClick={() => void me.refetch()}>Retry</Button></div>
        ) : (
          <form className="space-y-4" onSubmit={e => { e.preventDefault(); save.mutate(username); }}>
            <div className="space-y-2">
              <Label htmlFor="github-username">Your GitHub username</Label>
              <Input id="github-username" value={username} onChange={e => { setDraft(e.target.value); save.reset(); }} placeholder="octocat" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={save.isPending} aria-describedby="github-help" />
              <p id="github-help" className="text-xs text-muted-foreground">Enter your username, not a profile URL. Leave blank to remove the mapping. This does not verify or authorize your GitHub account.</p>
            </div>
            {save.isError && <p role="alert" className="text-sm text-destructive">{error ?? "Couldn’t save your GitHub username. Try again."}</p>}
            <Button type="submit" disabled={save.isPending || username === me.data.github_username}>{save.isPending ? "Saving…" : "Save"}</Button>
          </form>
        )}
      </div>
    </div>
  );
}
