"use client";

/**
 * OAuth consent screen.
 *
 * The backend authorize view (`apps.mcp_server.oauth_views.McpAuthorizationView`)
 * redirects here, forwarding its query string verbatim. We hand that same query
 * string back to `/api/oauth/authorize-request/`, which re-validates it
 * server-side — nothing on this page is trusted as input, so the parameters are
 * only ever passed through, never parsed or reconstructed.
 *
 * Both decisions end in a hard navigation to a URL the backend computes: allow
 * goes to the client's callback with a code, deny goes there with
 * `error=access_denied`. Denying by navigation rather than by closing the tab
 * matters — otherwise the waiting client just hangs.
 *
 * Renders standalone (no app shell); see the bypass in `Shell.tsx`.
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import type { OAuthConsentDecision, OAuthConsentRequest } from "@/lib/types";

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<Frame />}>
      <ConsentFlow />
    </Suspense>
  );
}

/** Shared chrome, so the suspended and resolved states don't shift layout. */
function Frame({ children }: { children?: React.ReactNode }) {
  return (
    <div className="h-dvh flex items-center justify-center px-4 py-8 bg-background overflow-y-auto">
      <div className="w-full max-w-[420px] rounded-xl border border-border/80 bg-card p-6">
        {children}
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="size-7 rounded-md bg-foreground grid place-items-center text-background text-[12px] font-semibold">
        C
      </div>
      <div className="text-[14px] font-semibold tracking-tight">
        Cyt Task Tracker
      </div>
    </div>
  );
}

function ConsentFlow() {
  const searchParams = useSearchParams();
  // The exact string the backend handed us. Re-serialising from parsed values
  // would risk dropping parameters we don't model (resource, nonce, claims).
  const query = searchParams.toString();

  // The authorize view redirects here with `error` instead of the request
  // parameters when validation failed before consent was even possible.
  const upstreamError = searchParams.get("error");

  const requestQuery = useQuery({
    queryKey: ["oauth-consent", query],
    queryFn: () =>
      apiFetch<OAuthConsentRequest>(`/api/oauth/authorize-request/?${query}`),
    enabled: !upstreamError,
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (allow: boolean) =>
      apiFetch<OAuthConsentDecision>(
        `/api/oauth/authorize-request/?${query}`,
        { method: "POST", body: { allow } },
      ),
    onSuccess: (data) => {
      // Hard navigation: the target is the client's callback on another origin.
      window.location.href = data.redirect_uri;
    },
  });

  if (upstreamError) {
    return (
      <ErrorCard
        title="This connection request isn't valid"
        detail={
          searchParams.get("error_description") ||
          `The authorization server rejected it (${upstreamError}).`
        }
      />
    );
  }

  if (requestQuery.isLoading) {
    return (
      <Frame>
        <div className="h-32 grid place-items-center">
          <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
        </div>
      </Frame>
    );
  }

  if (requestQuery.isError || !requestQuery.data) {
    const err = requestQuery.error;
    const detail =
      err instanceof ApiError && err.status === 403
        ? "Your session expired. Sign in again and retry the connection from your client."
        : err instanceof ApiError
          ? describeApiError(err)
          : "Something went wrong loading this request.";
    return <ErrorCard title="Couldn't load the connection request" detail={detail} />;
  }

  const req = requestQuery.data;
  const pending = decide.isPending;

  return (
    <Frame>
      <div className="space-y-5">
        <Brand />

        <div className="space-y-1.5">
          <h1 className="text-[16px] font-semibold tracking-tight">
            Connect {req.client_name}?
          </h1>
          <p className="text-[12px] text-muted-foreground">
            {req.client_name} is asking to access your Cyt workspace as{" "}
            <span className="font-medium text-foreground">
              {req.account.full_name || req.account.username}
            </span>
            . Anything it creates or changes will be attributed to you.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border/50">
          {req.scopes.map((scope) => (
            <div key={scope.name} className="flex gap-2.5 px-3 py-2.5">
              <Check className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-[12px] font-medium">{scope.description}</div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {scope.name}
                </div>
              </div>
            </div>
          ))}
        </div>

        <p className="flex gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 mt-px shrink-0" />
          <span>
            You can revoke this any time in Settings → Connections. Codes are
            returned to{" "}
            <span className="font-mono break-all">
              {safeOrigin(req.redirect_uri)}
            </span>
            .
          </span>
        </p>

        {decide.isError && (
          <p className="text-[12px] text-destructive">
            {decide.error instanceof ApiError
              ? describeApiError(decide.error)
              : "Couldn't complete the request."}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="flex-1 h-9 text-[13px]"
            disabled={pending}
            onClick={() => decide.mutate(false)}
          >
            Deny
          </Button>
          <Button
            className="flex-1 h-9 text-[13px]"
            disabled={pending}
            onClick={() => decide.mutate(true)}
          >
            {pending ? "Connecting..." : "Allow access"}
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <Frame>
      <div className="space-y-4">
        <Brand />
        <div className="flex gap-2.5">
          <TriangleAlert className="size-4 mt-0.5 shrink-0 text-destructive" />
          <div className="space-y-1 min-w-0">
            <h1 className="text-[14px] font-semibold tracking-tight">{title}</h1>
            <p className="text-[12px] text-muted-foreground">{detail}</p>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Nothing was granted. Start the connection again from your client.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          render={<a href="/board" />}
        >
          Back to Cyt
        </Button>
      </div>
    </Frame>
  );
}

/** Show the callback's origin rather than the full URI — the path is noise, and
 *  the origin is the part worth checking. */
function safeOrigin(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return uri;
  }
}

function describeApiError(err: ApiError): string {
  const payload = err.payload as
    | { error_description?: string; detail?: string }
    | null;
  return (
    payload?.error_description || payload?.detail || err.message
  );
}
