"use client";

/**
 * Drive data hooks — a Backblaze B2 file browser.
 *
 * B2 is the source of truth (no local models). Uploads are a two-step
 * presigned PUT: our API mints a signed URL, then the browser PUTs the bytes
 * straight to B2 (raw fetch — cross-origin, no cookies, and it MUST send the
 * exact Content-Type that was signed). Reads/deletes go through our API.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { driveListKey } from "@/lib/query-keys";

export type DriveFile = {
  key: string;
  name: string;
  size: number;
  last_modified: string | null;
};

export type DriveListResponse = {
  prefix: string;
  folders: string[];
  files: DriveFile[];
  next_token: string | null;
};

type PresignPut = {
  url: string;
  key: string;
  method: "PUT";
  headers: Record<string, string>;
};

export function useDriveList(prefix: string) {
  return useQuery({
    queryKey: driveListKey(prefix),
    queryFn: () =>
      apiFetch<DriveListResponse>("/api/drive/objects/", { query: { prefix } }),
  });
}

export function useUploadFile(prefix: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const dest = (prefix ? prefix.replace(/\/$/, "") + "/" : "") + file.name;
      const contentType = file.type || "application/octet-stream";
      // 1. ask our API for a presigned PUT URL
      const signed = await apiFetch<PresignPut>("/api/drive/upload-url/", {
        method: "POST",
        body: { path: dest, content_type: contentType },
      });
      // 2. PUT the bytes straight to B2 — raw fetch (no credentials/CSRF), and
      //    the Content-Type must match exactly what was signed or B2 returns 403.
      const res = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: file,
      });
      if (!res.ok) {
        throw new Error(`Upload to storage failed (${res.status}).`);
      }
      return signed.key;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drive"] }),
  });
}

export function useDeleteObject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<{ ok: boolean; deleted: string }>("/api/drive/delete/", {
        method: "DELETE",
        body: { key },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drive"] }),
  });
}

/** Fetch a presigned GET URL and trigger a browser download. */
export async function downloadObject(key: string, name: string): Promise<void> {
  const { url } = await apiFetch<{ url: string }>("/api/drive/download-url/", {
    query: { key },
  });
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
