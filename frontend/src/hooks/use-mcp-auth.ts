"use client";

/**
 * Queries and mutations for MCP authentication.
 *
 * Two independent things live here because they answer the same question
 * ("what can reach my data over MCP?") from opposite ends:
 *
 * - **OAuth connections** — client apps that completed the browser consent
 *   flow. Read-only plus revoke; the tokens themselves are minted by the OAuth
 *   endpoints, not here.
 * - **Personal access tokens** — for clients with no browser. Created here,
 *   and the plaintext is returned exactly once (same reveal-once contract as
 *   the webhook signing secret in `use-webhooks.ts`), so `onSuccess` has to
 *   hand it straight to the reveal dialog.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { mcpTokensKey, oauthConnectionsKey } from "@/lib/query-keys";
import type {
  McpToken,
  McpTokenCreated,
  McpTokenListResponse,
  OAuthConnectionListResponse,
} from "@/lib/types";

export function useOAuthConnectionsQuery() {
  return useQuery({
    queryKey: oauthConnectionsKey(),
    queryFn: () =>
      apiFetch<OAuthConnectionListResponse>("/api/oauth/connections/"),
  });
}

/** Revokes every access token, refresh token and pending grant this user holds
 *  for the application — anything less and the client just mints a new token. */
export function useRevokeOAuthConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: number) =>
      apiFetch<{ revoked: Record<string, number> }>(
        `/api/oauth/connections/${applicationId}/`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: oauthConnectionsKey() });
    },
  });
}

export function useMcpTokensQuery() {
  return useQuery({
    queryKey: mcpTokensKey(),
    queryFn: () => apiFetch<McpTokenListResponse>("/api/mcp/tokens/"),
  });
}

type CreateMcpTokenPayload = {
  name: string;
  scopes: string[];
  /** ISO-8601, or null for a token that never expires. */
  expires_at: string | null;
};

/** The create response is the only place the plaintext token appears — surface
 *  it to the caller via `onSuccess` and never refetch it. */
export function useCreateMcpToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMcpTokenPayload) =>
      apiFetch<McpTokenCreated>("/api/mcp/tokens/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mcpTokensKey() });
    },
  });
}

export function useRevokeMcpToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: McpToken["id"]) =>
      apiFetch<void>(`/api/mcp/tokens/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mcpTokensKey() });
    },
  });
}
