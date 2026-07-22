"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import {
  eventSourcesKey,
  externalEventsKey,
  externalEventSummaryKey,
} from "@/lib/query-keys";
import type {
  EventProvider,
  EventPageIcon,
  EventSource,
  EventSourceListResponse,
  EventSummary,
  EventWorkflowStatus,
  ExternalEvent,
  ExternalEventListResponse,
  MonitoringColumn,
} from "@/lib/types";

export function useEventSourcesQuery() {
  return useQuery({
    queryKey: eventSourcesKey(),
    queryFn: () =>
      apiFetch<EventSourceListResponse>("/api/integrations/event-sources/"),
  });
}

export function useCreateEventSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      name: string;
      provider: EventProvider;
      icon: EventPageIcon;
    }) =>
      apiFetch<EventSource>("/api/integrations/event-sources/", {
        method: "POST",
        body: payload,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventSourcesKey() }),
  });
}

export function useUpdateEventSource(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      payload: Partial<
        Pick<EventSource, "name" | "provider" | "icon" | "columns" | "active">
      > & { columns?: MonitoringColumn[] },
    ) =>
      apiFetch<EventSource>(`/api/integrations/event-sources/${id}/`, {
        method: "PATCH",
        body: payload,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventSourcesKey() }),
  });
}

export function useDeleteEventSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/integrations/event-sources/${id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: eventSourcesKey() });
      qc.invalidateQueries({ queryKey: ["external-events"] });
    },
  });
}

export type EventFilters = {
  source?: number;
  workflow_status?: EventWorkflowStatus;
  search?: string;
};

export function useEventsQuery(filters: EventFilters, enabled = true) {
  return useQuery({
    queryKey: externalEventsKey(filters),
    queryFn: () =>
      apiFetch<ExternalEventListResponse>("/api/integrations/events/", {
        query: filters,
      }),
    enabled,
    refetchInterval: 10_000,
  });
}

export function useEventSummaryQuery(source?: number, enabled = true) {
  return useQuery({
    queryKey: externalEventSummaryKey(source),
    queryFn: () =>
      apiFetch<EventSummary>("/api/integrations/events/summary/", {
        query: { source },
      }),
    enabled,
    refetchInterval: 10_000,
  });
}

export function useUpdateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, workflow_status }: { id: number; workflow_status: EventWorkflowStatus }) =>
      apiFetch<ExternalEvent>(`/api/integrations/events/${id}/`, {
        method: "PATCH",
        body: { workflow_status },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["external-events"] }),
  });
}
