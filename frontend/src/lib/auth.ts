import { apiFetch, ApiError, ensureCsrfCookie } from "./api";
import type { Me } from "./types";

export async function fetchMe(): Promise<Me | null> {
  try {
    return await apiFetch<Me>("/api/auth/me/");
  } catch (err) {
    // Treat both 401 (not authenticated) and 403 (DRF's default for anonymous
    // requests against IsAuthenticated views) as "please log in".
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}

export async function login(
  username: string,
  password: string,
): Promise<Me> {
  await ensureCsrfCookie();
  return apiFetch<Me>("/api/auth/login/", {
    method: "POST",
    body: { username, password },
  });
}

export async function logout(): Promise<void> {
  await apiFetch<void>("/api/auth/logout/", { method: "POST" });
}
