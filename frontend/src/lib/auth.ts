import { apiFetch, ApiError, ensureCsrfCookie } from "./api";
import type { Me, ModuleKey } from "./types";

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

export function hasModule(user: Me, module: ModuleKey): boolean {
  return user.is_staff || user.modules.includes(module);
}

/** The modules that open each page (any one is enough). The backend enforces
 *  the same split per API prefix (`API_MODULES` in `apps/tasks/access.py`);
 *  this only keeps users out of pages whose every request would be refused.
 *  Home renders tasks and bets, so either opens it. Routes listed nowhere —
 *  settings admin pages, `/projects` — stay staff-only (fail closed). */
const ROUTE_MODULES: [route: string, modules: ModuleKey[]][] = [
  ["/", ["tasks", "bets"]],
  ["/board", ["tasks"]],
  ["/reviews", ["tasks"]],
  ["/focus", ["tasks"]],
  ["/bets", ["bets"]],
  ["/analytics", ["analytics"]],
  ["/crm", ["crm", "billing"]],
  ["/meetings", ["meetings"]],
  ["/reports", ["reports"]],
  ["/wiki", ["wiki"]],
  ["/llm-wiki", ["llm_wiki"]],
  ["/drive", ["drive"]],
  ["/events", ["operations"]],
  ["/routines", ["operations"]],
  ["/services", ["operations"]],
  ["/monitoring", ["operations"]],
];

/** Personal pages every signed-in user may open. */
const OPEN_ROUTES = ["/settings/quick-actions"];

const matches = (path: string, route: string) =>
  route === "/" ? path === "/" : path === route || path.startsWith(`${route}/`);

export function canOpen(user: Me, path: string): boolean {
  if (user.is_staff || OPEN_ROUTES.some((route) => matches(path, route))) return true;
  const entry = ROUTE_MODULES.find(([route]) => matches(path, route));
  return !!entry && entry[1].some((module) => user.modules.includes(module));
}

/** Where a user lands when they open a page they can't use: Home, else the
 *  first module page they hold, else the one page everyone has. */
export function homeFor(user: Me): string {
  const order = ["/", "/wiki", "/meetings", "/drive", "/llm-wiki", "/crm", "/reports", "/analytics", "/routines"];
  return order.find((path) => canOpen(user, path)) ?? OPEN_ROUTES[0];
}
