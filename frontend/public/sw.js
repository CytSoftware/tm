/* Cyt Task Tracker service worker.
 *
 * Intentionally minimal: its job is (1) make the app installable as a PWA and
 * (2) give a friendly offline fallback for navigations. It must NEVER cache
 * API responses, auth endpoints, or WebSocket upgrades — those have to stay
 * live because the frontend relies on TanStack Query + Channels for freshness.
 */

const VERSION = "cyt-sw-v1";
const STATIC_CACHE = `${VERSION}-static`;
const NAV_FALLBACK = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.add(NAV_FALLBACK)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Cross-origin (e.g. backend on a separate subdomain) — let the browser handle it.
  if (url.origin !== self.location.origin) return;

  // Never touch API, WS, auth, or MCP traffic.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws/") ||
    url.pathname.startsWith("/oauth/") ||
    url.pathname.startsWith("/mcp")
  ) {
    return;
  }

  // Navigations: network-first, fall back to cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(STATIC_CACHE);
          cache.put(NAV_FALLBACK, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(STATIC_CACHE);
          const cached = await cache.match(NAV_FALLBACK);
          return (
            cached ||
            new Response("Offline", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Hashed Next.js assets are immutable — stale-while-revalidate is safe.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })(),
    );
  }
});
