import { apiFetch, ApiError, ensureCsrfCookie } from "./api";
import type { User } from "./types";

export async function fetchMe(): Promise<User | null> {
  try {
    return await apiFetch<User>("/api/auth/me/");
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
): Promise<User> {
  await ensureCsrfCookie();
  return apiFetch<User>("/api/auth/login/", {
    method: "POST",
    body: { username, password },
  });
}

export async function logout(): Promise<void> {
  await apiFetch<void>("/api/auth/logout/", { method: "POST" });
}
