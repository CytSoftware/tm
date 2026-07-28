"use client";

/**
 * Outbound webhooks settings page.
 *
 * Endpoints are owned by a user but can be scoped "mine" (task events
 * relevant to the owner — assigned/updated/moved/completed/deleted) or
 * "all" (org-wide: every matching task event workspace-wide, including
 * "created"). The signing secret is reveal-once — shown in a dialog right
 * after create or rotate and never again (it's excluded from list
 * responses).
 */

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  MoreHorizontal,
  Plus,
  Send,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { formatDuration } from "@/components/task/TimeInColumn";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useProjectsQuery } from "@/hooks/use-projects";
import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
  useWebhookDeliveriesQuery,
  useWebhooksQuery,
} from "@/hooks/use-webhooks";
import type {
  Project,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointCreated,
  WebhookEventType,
  WebhookScope,
} from "@/lib/types";

const EVENT_TYPES: WebhookEventType[] = [
  "created",
  "assigned",
  "updated",
  "moved",
  "completed",
  "deleted",
  "review_requested",
];

const VERB_LABELS: Record<WebhookEventType, string> = {
  created: "Created",
  assigned: "Assigned",
  updated: "Updated",
  moved: "Moved",
  completed: "Completed",
  deleted: "Deleted",
  review_requested: "Review requested",
};

const STATUS_DOT: Record<WebhookDeliveryStatus, string> = {
  success: "bg-green-500",
  pending: "bg-amber-500",
  failed: "bg-red-500",
};

type RevealedSecret = { name: string; secret: string };

export default function WebhooksSettingsPage() {
  const webhooksQuery = useWebhooksQuery();

  if (webhooksQuery.isLoading) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (webhooksQuery.isError || !webhooksQuery.data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
        <p className="text-[14px] text-muted-foreground">
          Couldn&apos;t load outgoing webhooks.
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

  return <WebhooksPageBody endpoints={webhooksQuery.data.results} />;
}

function WebhooksPageBody({ endpoints }: { endpoints: WebhookEndpoint[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] =
    useState<RevealedSecret | null>(null);

  const projectsQuery = useProjectsQuery();
  const projects: Project[] = projectsQuery.data?.results ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 lg:px-6 py-8 space-y-6">
        <header className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-[18px] font-semibold tracking-tight">
              Outgoing webhooks
            </h1>
            <p className="text-[12px] text-muted-foreground">
              Send Cyt task events to external endpoints as signed HTTP POSTs.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            Add outgoing webhook
          </Button>
        </header>

        <section className="rounded-lg border border-border bg-card">
          {endpoints.length === 0 && (
            <p className="px-4 py-6 text-[12px] text-muted-foreground text-center">
              No outgoing webhooks yet. Add one to push Cyt task events to an
              external endpoint.
            </p>
          )}
          {endpoints.map((endpoint) => (
            <WebhookRow
              key={endpoint.id}
              endpoint={endpoint}
              projects={projects}
              onSecretRevealed={setRevealedSecret}
            />
          ))}
        </section>
      </div>

      {createOpen && (
        <CreateWebhookDialog
          projects={projects}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            setRevealedSecret({ name: created.name, secret: created.secret });
          }}
        />
      )}
      {revealedSecret && (
        <SecretRevealDialog
          name={revealedSecret.name}
          secret={revealedSecret.secret}
          onClose={() => setRevealedSecret(null)}
        />
      )}
    </div>
  );
}

function WebhookRow({
  endpoint,
  projects,
  onSecretRevealed,
}: {
  endpoint: WebhookEndpoint;
  projects: Project[];
  onSecretRevealed: (revealed: RevealedSecret) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const updateWebhook = useUpdateWebhook(endpoint.id);
  const deleteWebhook = useDeleteWebhook();
  const rotateSecret = useRotateWebhookSecret();
  const testWebhook = useTestWebhook();

  const projectName =
    endpoint.project !== null
      ? (projects.find((p) => p.id === endpoint.project)?.name ??
        `Project #${endpoint.project}`)
      : "All projects";

  function handleDelete() {
    if (confirm(`Delete webhook "${endpoint.name}"?`)) {
      deleteWebhook.mutate(endpoint.id);
    }
  }

  function handleRotate() {
    rotateSecret.mutate(endpoint.id, {
      onSuccess: (data) => {
        onSecretRevealed({ name: endpoint.name, secret: data.secret });
      },
    });
  }

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-baseline gap-2">
            <span className="text-[13px] font-medium truncate">
              {endpoint.name}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground truncate">
              {endpoint.url}
            </span>
          </div>
          <Switch
            size="sm"
            checked={endpoint.active}
            onCheckedChange={(checked) =>
              updateWebhook.mutate({ active: checked })
            }
            disabled={updateWebhook.isPending}
            aria-label={`${endpoint.name} active`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`${endpoint.name} actions`}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem
                onClick={handleRotate}
                disabled={rotateSecret.isPending}
              >
                Rotate secret
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {endpoint.scope === "all" && (
            <Badge variant="default">Org-wide</Badge>
          )}
          {endpoint.event_types.length === 0 ? (
            <Badge variant="outline">All events</Badge>
          ) : (
            endpoint.event_types.map((verb) => (
              <Badge key={verb} variant="secondary">
                {VERB_LABELS[verb] ?? verb}
              </Badge>
            ))
          )}
          <span className="text-[11px] text-muted-foreground">
            · {projectName}
          </span>
          {endpoint.scope !== "all" && endpoint.include_self && (
            <span className="text-[11px] text-muted-foreground">
              · includes own actions
            </span>
          )}
        </div>

        {endpoint.disabled_at && (
          <p className="text-[11px] text-destructive">
            Auto-disabled after repeated failures
            {endpoint.consecutive_failures > 0 &&
              ` (${endpoint.consecutive_failures} consecutive)`}
            . Fix the endpoint, then re-enable it above.
          </p>
        )}

        <div className="flex items-center gap-2 pt-0.5">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => testWebhook.mutate(endpoint.id)}
            disabled={testWebhook.isPending}
          >
            <Send className="size-3" />
            {testWebhook.isPending
              ? "Sending..."
              : testWebhook.data?.status === "success"
                ? "Delivered ✓"
                : "Send test"}
          </Button>
          {testWebhook.isError && (
            <span className="text-[11px] text-destructive">
              Test failed to enqueue.
            </span>
          )}
          {testWebhook.data && testWebhook.data.status !== "success" && (
            <span className="text-[11px] text-destructive">
              Delivery failed
              {testWebhook.data.response_status !== null
                ? ` (HTTP ${testWebhook.data.response_status})`
                : testWebhook.data.error
                  ? ` (${testWebhook.data.error})`
                  : ""}
              .
            </span>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Recent deliveries
          </button>
        </div>
      </div>

      {expanded && (
        <WebhookDeliveries endpointId={endpoint.id} enabled={expanded} />
      )}
    </div>
  );
}

function WebhookDeliveries({
  endpointId,
  enabled,
}: {
  endpointId: number;
  enabled: boolean;
}) {
  const deliveriesQuery = useWebhookDeliveriesQuery(endpointId, enabled);

  if (deliveriesQuery.isLoading) {
    return (
      <p className="px-4 pb-3 text-[11px] text-muted-foreground">
        Loading deliveries...
      </p>
    );
  }

  if (deliveriesQuery.isError) {
    return (
      <p className="px-4 pb-3 text-[11px] text-destructive">
        Couldn&apos;t load deliveries.
      </p>
    );
  }

  const deliveries = deliveriesQuery.data ?? [];

  if (deliveries.length === 0) {
    return (
      <p className="px-4 pb-3 text-[11px] text-muted-foreground">
        No deliveries yet.
      </p>
    );
  }

  return (
    <div className="mx-4 mb-3 rounded-md border border-border/60 bg-muted/20 divide-y divide-border/40">
      {deliveries.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
        >
          <span
            className={cn(
              "size-1.5 rounded-full shrink-0",
              STATUS_DOT[d.status] ?? "bg-muted-foreground/40",
            )}
            aria-label={d.status}
          />
          <span className="font-mono text-muted-foreground shrink-0">
            {d.event}
          </span>
          {d.task_key && (
            <span className="font-mono shrink-0">{d.task_key}</span>
          )}
          <span className="text-muted-foreground shrink-0">
            ×{d.attempts}
          </span>
          <span
            className={cn(
              "flex-1 min-w-0 truncate",
              d.status === "failed" && d.error
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {d.response_status !== null
              ? `HTTP ${d.response_status}`
              : d.error || (d.status === "pending" ? "queued" : "—")}
          </span>
          <span className="text-muted-foreground/80 shrink-0">
            {formatDuration(d.created_at)} ago
          </span>
        </div>
      ))}
    </div>
  );
}

function CreateWebhookDialog({
  projects,
  onClose,
  onCreated,
}: {
  projects: Project[];
  onClose: () => void;
  onCreated: (created: WebhookEndpointCreated) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  // Default ON — the primary use case is a personal agent reacting to the
  // owner's own task activity. Only meaningful for scope="mine".
  const [includeSelf, setIncludeSelf] = useState(true);
  const [scope, setScope] = useState<WebhookScope>("mine");

  const mutation = useCreateWebhook();

  const activeProjects = projects.filter((p) => !p.archived);

  function toggleEventType(verb: WebhookEventType) {
    setEventTypes((prev) =>
      prev.includes(verb) ? prev.filter((v) => v !== verb) : [...prev, verb],
    );
  }

  function handleSubmit() {
    if (!name.trim() || !url.trim()) return;
    mutation.mutate(
      {
        name: name.trim(),
        url: url.trim(),
        event_types: eventTypes,
        project: projectId,
        include_self: includeSelf,
        scope,
      },
      {
        onSuccess: (created) => {
          onCreated(created);
        },
      },
    );
  }

  const error = mutation.error;
  const errorMessage =
    error instanceof ApiError
      ? formatApiError(error)
      : error
        ? "Something went wrong."
        : null;

  const selectItems = {
    "": "All projects",
    ...Object.fromEntries(
      activeProjects.map((p) => [String(p.id), p.name]),
    ),
  } as Record<string, React.ReactNode>;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-[440px] p-0 gap-0 flex flex-col"
        showCloseButton={false}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-[15px] tracking-tight">
            New outgoing webhook
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Your task events will be POSTed to this URL, signed with a secret
            shown once after creation.
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
                placeholder="Personal agent"
                autoFocus
                className="h-9 text-[13px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                URL
              </Label>
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hook"
                className="h-9 text-[13px] font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Events
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                {EVENT_TYPES.map((verb) => (
                  <label
                    key={verb}
                    className="flex items-center gap-2 text-[13px] cursor-pointer"
                  >
                    <Checkbox
                      checked={eventTypes.includes(verb)}
                      onCheckedChange={() => toggleEventType(verb)}
                    />
                    {VERB_LABELS[verb]}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Leave all unchecked to receive every event type.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Scope
              </Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as WebhookScope)}
                items={{
                  mine: "Only my events",
                  all: "All workspace events",
                }}
              >
                <SelectTrigger className="h-9 w-full text-[13px]">
                  <SelectValue placeholder="Only my events" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mine">Only my events</SelectItem>
                  <SelectItem value="all">All workspace events</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Project scope
              </Label>
              <Select
                value={projectId !== null ? String(projectId) : ""}
                onValueChange={(v) =>
                  setProjectId(v === "" || v === null ? null : Number(v))
                }
                items={selectItems}
              >
                <SelectTrigger className="h-9 w-full text-[13px]">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All projects</SelectItem>
                  {activeProjects.map((p) => (
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
            </div>
            {scope === "all" ? (
              <p className="text-[11px] text-muted-foreground">
                Org-wide webhooks fire for everyone&apos;s actions, including
                your own.
              </p>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-[13px] font-normal">
                    Also fire for my own actions
                  </Label>
                  <Switch
                    checked={includeSelf}
                    onCheckedChange={(checked) => setIncludeSelf(checked)}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Fires even when you caused the change yourself — needed if a
                  personal agent should react to your own edits.
                </p>
              </div>
            )}
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
              disabled={mutation.isPending || !name.trim() || !url.trim()}
            >
              {mutation.isPending ? "Creating..." : "Create outgoing webhook"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretRevealDialog({
  name,
  secret,
  onClose,
}: {
  name: string;
  secret: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. non-secure context) — user can select
      // the text manually.
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
            Webhook secret — {name}
          </DialogTitle>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Use it to verify the <span className="font-mono">X-Cyt-Signature</span>{" "}
            header on incoming deliveries.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] break-all select-all">
              {secret}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleCopy}
              aria-label="Copy secret"
            >
              {copied ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Store this now — it won&apos;t be shown again. Use Rotate to
            generate a new one.
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

function formatApiError(err: ApiError): string {
  const payload = err.payload as
    | Record<string, string[] | string>
    | { detail?: string }
    | null;
  if (!payload) return err.message;
  if (typeof payload === "object" && "detail" in payload && payload.detail) {
    return String(payload.detail);
  }
  // DRF field errors: { url: ["Enter a valid URL."] }
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
