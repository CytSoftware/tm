"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";
import type { Me, QuickAction } from "@/lib/types";

export function useQuickActions() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  const mutation = useMutation({
    mutationFn: (quickActions: QuickAction[]) =>
      apiFetch<Me>("/api/auth/me/", {
        method: "PATCH",
        body: { preferences: { quick_actions: quickActions } },
      }),
    onSuccess: (me) => queryClient.setQueryData(meKey(), me),
  });

  return {
    query: meQuery,
    quickActions: meQuery.data?.preferences?.quick_actions ?? [],
    save: mutation,
  };
}
