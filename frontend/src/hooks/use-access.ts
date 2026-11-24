"use client";

/**
 * Module grants. `useHasModule` is the per-component check (staff hold
 * every module); the rest backs Settings → Access, the staff-only page that
 * edits each user's modules and projects.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { fetchMe, hasModule } from "@/lib/auth";
import { errorMessage } from "@/lib/crm-meta";
import { accessKey, meKey } from "@/lib/query-keys";
import type { ModuleKey } from "@/lib/types";

export function useHasModule(module: ModuleKey): boolean {
  const { data: me } = useQuery({ queryKey: meKey(), queryFn: fetchMe });
  return !!me && hasModule(me, module);
}

export type AccessUser = {
  id: number;
  username: string;
  name: string;
  is_staff: boolean;
  modules: ModuleKey[];
  project_ids: number[];
};

export type AccessData = {
  modules: ModuleKey[];
  projects: { id: number; prefix: string; name: string }[];
  users: AccessUser[];
};

export function useAccessQuery() {
  return useQuery({
    queryKey: accessKey(),
    queryFn: () => apiFetch<AccessData>("/api/access/"),
  });
}

type AccessPatch = { id: number; modules?: ModuleKey[]; project_ids?: number[] };

/** Saves one user's full module and/or project list. Optimistic; on error
 *  only that user's row is restored, so a concurrent toggle on another row
 *  isn't undone with it. */
export function useUpdateAccess() {
  const qc = useQueryClient();
  const setRow = (id: number, row: (u: AccessUser) => AccessUser) =>
    qc.setQueryData<AccessData>(accessKey(), (data) =>
      data && { ...data, users: data.users.map((u) => (u.id === id ? row(u) : u)) },
    );
  return useMutation({
    mutationKey: accessKey(),
    mutationFn: ({ id, ...body }: AccessPatch) =>
      apiFetch<AccessUser>(`/api/access/users/${id}/`, { method: "PATCH", body }),
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: accessKey() });
      const previous = qc.getQueryData<AccessData>(accessKey())?.users.find((u) => u.id === id);
      setRow(id, (u) => ({ ...u, ...patch }));
      return { previous };
    },
    // A later toggle still in flight already sent a newer full list; taking
    // this response would flash its change off until that one lands.
    onSuccess: (row) => {
      if (qc.isMutating({ mutationKey: accessKey() }) <= 1) setRow(row.id, () => row);
    },
    onError: (err, { id }, ctx) => {
      if (ctx?.previous) setRow(id, () => ctx.previous!);
      toast.error(errorMessage(err));
    },
  });
}
