"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { infrastructureServicesKey } from "@/lib/query-keys";
import type {
  InfrastructureService,
  InfrastructureServiceListResponse,
} from "@/lib/types";

export type InfrastructureServiceInput = {
  name: string;
  url: string;
  category: string;
  description: string;
  logo?: File | null;
  removeLogo?: boolean;
};

function toFormData(input: InfrastructureServiceInput) {
  const form = new FormData();
  form.append("name", input.name);
  form.append("url", input.url);
  form.append("category", input.category);
  form.append("description", input.description);
  if (input.logo) form.append("logo", input.logo);
  if (input.removeLogo) form.append("remove_logo", "true");
  return form;
}

export function useInfrastructureServicesQuery() {
  return useQuery({
    queryKey: infrastructureServicesKey(),
    queryFn: () =>
      apiFetch<InfrastructureServiceListResponse>(
        "/api/integrations/services/",
      ),
  });
}

export function useCreateInfrastructureService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InfrastructureServiceInput) =>
      apiFetch<InfrastructureService>("/api/integrations/services/", {
        method: "POST",
        body: toFormData(input),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infrastructureServicesKey() }),
  });
}

export function useUpdateInfrastructureService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: InfrastructureServiceInput;
    }) =>
      apiFetch<InfrastructureService>(`/api/integrations/services/${id}/`, {
        method: "PATCH",
        body: toFormData(input),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infrastructureServicesKey() }),
  });
}

export function useDeleteInfrastructureService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/integrations/services/${id}/`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infrastructureServicesKey() }),
  });
}
