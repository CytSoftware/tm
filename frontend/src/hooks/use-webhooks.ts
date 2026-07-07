"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { webhookDeliveriesKey, webhooksKey } from "@/lib/query-keys";
import type {
  NotificationVerb,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
  WebhookEndpointListResponse,
} from "@/lib/types";

/** Single source of truth for the webhook endpoint list. */
export function useWebhooksQuery() {
  return useQuery({
    queryKey: webhooksKey(),
    queryFn: () => apiFetch<WebhookEndpointListResponse>("/api/webhooks/"),
  });
}

type CreateWebhookPayload = {
  name: string;
  url: string;
  /** Empty array = subscribe to all events. */
  event_types: NotificationVerb[];
  /** null = all projects. */
  project: number | null;
  include_self: boolean;
};

/** The create response is the only place the plaintext secret appears —
 *  surface it to the caller (secret reveal dialog) via `onSuccess`. */
export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWebhookPayload) =>
      apiFetch<WebhookEndpointCreated>("/api/webhooks/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: webhooksKey() });
    },
  });
}

type UpdateWebhookPayload = Partial<
  Pick<
    WebhookEndpoint,
    "name" | "url" | "event_types" | "project" | "include_self" | "active"
  >
>;

export function useUpdateWebhook(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateWebhookPayload) =>
      apiFetch<WebhookEndpoint>(`/api/webhooks/${id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: webhooksKey() });
    },
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/webhooks/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: webhooksKey() });
    },
  });
}

/** Rotating invalidates the old secret immediately; the new one is returned
 *  exactly once — pipe it into the secret reveal dialog. */
export function useRotateWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ secret: string }>(`/api/webhooks/${id}/rotate_secret/`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: webhooksKey() });
    },
  });
}

/** The test action attempts the delivery synchronously and returns the
 *  finished delivery row — status/response_status reflect the real outcome. */
export function useTestWebhook() {
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<WebhookDelivery>(`/api/webhooks/${id}/test/`, {
        method: "POST",
      }),
  });
}

/** Recent (≤50) deliveries for one endpoint. Lazy — pass `enabled` from the
 *  row's expand state so we only fetch when the panel is open. */
export function useWebhookDeliveriesQuery(id: number, enabled: boolean) {
  return useQuery({
    queryKey: webhookDeliveriesKey(id),
    queryFn: () => apiFetch<WebhookDelivery[]>(`/api/webhooks/${id}/deliveries/`),
    enabled,
  });
}
