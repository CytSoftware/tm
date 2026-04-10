/**
 * HTTP client for the task tracker API.
 *
 * Design choices:
 * - `credentials: "include"` so Django session cookies flow on every request.
 * - CSRF token is read from the `csrftoken` cookie (seeded by `/api/auth/csrf/`)
 *   and attached to unsafe methods.
 * - Errors throw a typed `ApiError` so TanStack Query can surface them.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
};

export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, query, headers, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();

  let url = API_URL + path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        params.append(k, String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  const mergedHeaders = new Headers(headers);
  if (body !== undefined) {
    mergedHeaders.set("Content-Type", "application/json");
  }
  if (UNSAFE_METHODS.has(method)) {
    const csrf = getCookie("csrftoken");
    if (csrf) mergedHeaders.set("X-CSRFToken", csrf);
  }

  const response = await fetch(url, {
    ...rest,
    method,
    credentials: "include",
    headers: mergedHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // body was not JSON
    }
    throw new ApiError(
      `API ${method} ${path} failed with ${response.status}`,
      response.status,
      payload,
    );
  }

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

/** Call once on boot to seed the csrftoken cookie. */
export async function ensureCsrfCookie(): Promise<void> {
  await apiFetch<{ csrfToken: string }>("/api/auth/csrf/");
}
