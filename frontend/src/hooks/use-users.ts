"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { usersKey } from "@/lib/query-keys";
import type { User } from "@/lib/types";

export function useUsersQuery() {
  return useQuery({
    queryKey: usersKey(),
    queryFn: () => apiFetch<User[]>("/api/users/"),
  });
}
