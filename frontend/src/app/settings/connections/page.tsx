"use client";

/**
 * Connections settings — everything that can reach this account over MCP.
 *
 * Two sections, because there are two ways in:
 *
 * 1. **Connected apps** — clients that completed the browser OAuth flow
 *    (claude.ai, Cursor). One row per application even though each refresh
 *    mints a new access token; revoking clears access tokens, refresh tokens
 *    and pending grants together, since leaving the refresh token alive would
 *    let the client mint a new one seconds later.
 * 2. **Personal access tokens** — for clients with no browser (Claude Code,
 *    cron). Reveal-once on create, exactly like the webhook signing secret in
 *    `settings/outgoing-webhooks`.
 */

import { useState } from "react";
import { Check, Copy, KeyRound, MoreHorizontal, Plug, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDuration } from "@/components/task/TimeInColumn";
import { ApiError } from "@/lib/api";
import {
  useCreateMcpToken,
  useMcpTokensQuery,
  useOAuthConnectionsQuery,
  useRevokeMcpToken,
  useRevokeOAuthConnection,
} from "@/hooks/use-mcp-auth";
import type { McpToken, McpTokenCreated, OAuthConnection } from "@/lib/types";

const SCOPE_LABELS: Record<string, string> = {
  read: "Read",
  write: "Write",
};

/** Expiry presets, in days. `null` = never. */
const EXPIRY_OPTIONS: Record<string, string> = {
  never: "Never expires",
  "30": "30 days",
  "90": "90 days",
  "365": "1 year",
};

export default function ConnectionsSettingsPage() {
  const [revealed, setRevealed] = useState<McpTokenCreated | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 lg:px-6 py-8 space-y-8">
        <header>
          <h1 className="text-[18px] font-semibold tracking-tight">
            Connections
          </h1>
          <p className="text-[12px] text-muted-foreground">
            AI clients and scripts that can reach your Cyt workspace over MCP.
          </p>
        </header>

        <ConnectedApps />

        <PersonalTokens onCreate={() => setCreateOpen(true)} />
      </div>

      {createOpen && (
        <CreateTokenDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(token) => {
            setCreateOpen(false);
            setRevealed(token);
          }}
        />
      )}
      {revealed && (
        <TokenRevealDialog
          token={revealed}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Connected apps
// ─────────────────────────────────────────────────────────────────────────

function ConnectedApps() {
  const query = useOAuthConnectionsQuery();
  const connections = query.data?.results ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2">
        <Plug className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight">
            Connected apps
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Clients you approved through the browser. Add one by pasting this
            server&apos;s MCP URL into the client — it handles the rest.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {query.isLoading && (
          <p className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            Loading...
          </p>
        )}
        {query.isError && (
          <p className="px-4 py-6 text-center text-[12px] text-destructive">
            Couldn&apos;t load connected apps.
          </p>
        )}
        {!query.isLoading && !query.isError && connections.length === 0 && (
          <p className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            No connected apps yet.
          </p>
        )}
        {connections.map((connection) => (
          <ConnectionRow key={connection.application_id} connection={connection} />
        ))}
      </div>
    </section>
  );
}

function ConnectionRow({ connection }: { connection: OAuthConnection }) {
  const revoke = useRevokeOAuthConnection();

  function handleRevoke() {
    if (
      confirm(
        `Disconnect "${connection.name}"? It will need to be re-authorized before it can reach your workspace again.`,
      )
    ) {
      revoke.mutate(connection.application_id);
    }
  }

  return (
    <div className="border-b border-border/60 last:border-b-0 px-4 py-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium">
          {connection.name}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`${connection.name} actions`}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem
              variant="destructive"
              onClick={handleRevoke}
              disabled={revoke.isPending}
            >
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {connection.scopes.map((scope) => (
          <Badge key={scope} variant="secondary">
            {SCOPE_LABELS[scope] ?? scope}
          </Badge>
        ))}
        <span className="text-[11px] text-muted-foreground">
          · connected {formatDuration(connection.first_authorized_at)} ago
        </span>
        <span className="text-[11px] text-muted-foreground">
          · last token {formatDuration(connection.last_authorized_at)} ago
        </span>
      </div>
      <p className="font-mono text-[10px] text-muted-foreground truncate">
        {connection.client_id}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Personal access tokens
// ─────────────────────────────────────────────────────────────────────────

function PersonalTokens({ onCreate }: { onCreate: () => void }) {
  const query = useMcpTokensQuery();
  const tokens = query.data?.results ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2">
        <KeyRound className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight">
            Personal access tokens
          </h2>
          <p className="text-[11px] text-muted-foreground">
            For clients that can&apos;t open a browser. Send it as{" "}
            <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>.
            Writes are attributed to you.
          </p>
        </div>
        <Button size="sm" onClick={onCreate}>
          <Plus className="size-3.5" />
          New token
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {query.isLoading && (
          <p className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            Loading...
          </p>
        )}
        {query.isError && (
          <p className="px-4 py-6 text-center text-[12px] text-destructive">
            Couldn&apos;t load tokens.
          </p>
        )}
        {!query.isLoading && !query.isError && tokens.length === 0 && (
          <p className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            No personal access tokens yet.
          </p>
        )}
        {tokens.map((token) => (
          <TokenRow key={token.id} token={token} />
        ))}
      </div>
    </section>
  );
}

function TokenRow({ token }: { token: McpToken }) {
  const revoke = useRevokeMcpToken();

  function handleRevoke() {
    if (
      confirm(
        `Revoke "${token.name}"? Any client using it will stop working immediately.`,
      )
    ) {
      revoke.mutate(token.id);
    }
  }

  return (
    <div className="border-b border-border/60 last:border-b-0 px-4 py-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className="text-[13px] font-medium truncate">{token.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground truncate">
            {token.token_prefix}…
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`${token.name} actions`}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem
              variant="destructive"
              onClick={handleRevoke}
              disabled={revoke.isPending}
            >
              Revoke
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {token.scopes.map((scope) => (
          <Badge key={scope} variant="secondary">
            {SCOPE_LABELS[scope] ?? scope}
          </Badge>
        ))}
        {token.is_expired && <Badge variant="outline">Expired</Badge>}
        <span className="text-[11px] text-muted-foreground">
          ·{" "}
          {token.last_used_at
            ? `last used ${formatDuration(token.last_used_at)} ago`
            : "never used"}
        </span>
        {token.expires_at && !token.is_expired && (
          <span className="text-[11px] text-muted-foreground">
            {/* An absolute date, not formatDuration — that helper clamps
                future timestamps to "just now". */}
            · expires {formatDate(token.expires_at)}
          </span>
        )}
      </div>
    </div>
  );
}

function CreateTokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: McpTokenCreated) => void;
}) {
  const [name, setName] = useState("");
  const [canWrite, setCanWrite] = useState(true);
  const [expiry, setExpiry] = useState("never");

  const mutation = useCreateMcpToken();

  function handleSubmit() {
    if (!name.trim()) return;
    mutation.mutate(
      {
        name: name.trim(),
        scopes: canWrite ? ["read", "write"] : ["read"],
        expires_at: expiresAtIso(expiry),
      },
      { onSuccess: onCreated },
    );
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
        className="max-w-[440px] p-0 gap-0 flex flex-col"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            New personal access token
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Shown once after creation and never again.
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
                placeholder="Claude Code on the laptop"
                autoFocus
                className="h-9 text-[13px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Expiry
              </Label>
              <Select
                value={expiry}
                onValueChange={(v) => setExpiry(String(v))}
                items={EXPIRY_OPTIONS}
              >
                <SelectTrigger className="h-9 w-full text-[13px]">
                  <SelectValue placeholder="Never expires" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXPIRY_OPTIONS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                <Checkbox
                  checked={canWrite}
                  onCheckedChange={(checked) => setCanWrite(Boolean(checked))}
                />
                Allow changes (write access)
              </label>
              <p className="text-[11px] text-muted-foreground">
                Uncheck for a read-only token — it can list and read, but every
                tool that modifies data will refuse.
              </p>
            </div>
            {errorMessage && (
              <p className="text-[12px] text-destructive">{errorMessage}</p>
            )}
          </div>
          <div className="shrink-0 px-5 py-3 border-t border-border/60 flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={mutation.isPending || !name.trim()}
            >
              {mutation.isPending ? "Creating..." : "Create token"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TokenRevealDialog({
  token,
  onClose,
}: {
  token: McpTokenCreated;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. non-secure context) — the value is
      // select-all'able below.
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-md p-0 gap-0 flex flex-col"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            Access token — {token.name}
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Send it to the MCP endpoint as{" "}
            <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] break-all select-all">
              {token.token}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleCopy}
              aria-label="Copy token"
            >
              {copied ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Store this now — it won&apos;t be shown again. Revoke it here if it
            leaks.
          </p>
        </div>
        <div className="shrink-0 px-5 py-3 border-t border-border/60 flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Turn an expiry preset into an ISO timestamp, or null for "never". */
function expiresAtIso(preset: string): string | null {
  if (preset === "never") return null;
  const days = Number(preset);
  if (!Number.isFinite(days)) return null;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
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
