# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Monorepo with two deployables:

- `backend/` — Django 6 + DRF + Channels + MCP server, Python 3.12+, managed with `uv`.
- `frontend/` — Next.js 16 (App Router) + React 19 + TanStack Query + Tailwind v4 + shadcn.

Each is deployed as a separate Dokploy app in production. `docker-compose.yml` is a local-dev/reference file only.

## Common commands

### Backend (run from `backend/`)

```bash
uv sync                                      # install deps from uv.lock
uv run python manage.py migrate               # apply migrations
uv run python manage.py runserver              # dev (note: Daphne replaces runserver — serves HTTP + WS + MCP)
uv run daphne -b 0.0.0.0 -p 8000 core.asgi:application  # prod-equivalent ASGI server
uv run python manage.py createsuperuser
uv run python manage.py makemigrations tasks
uv run python manage.py generate_recurring_tasks    # fire recurring templates whose next_run has passed
uv run python manage.py mcp_serve             # MCP over stdio (for Claude Desktop). Remote MCP is auto-served at /mcp/ by daphne.
uv run python manage.py create_mcp_oauth_app  # idempotent OAuth app bootstrap (runs from entrypoint.sh)
```

There is no Django test suite in place yet (`tests.py` files are empty stubs).

### Frontend (run from `frontend/`)

```bash
npm install
npm run dev      # next dev on :3000
npm run build    # next build (standalone output)
npm run lint     # eslint
```

### Docker (local)

```bash
docker compose up --build
```

## Architecture

### One ASGI app, three protocols

`backend/core/asgi.py` is the single source of entry for Daphne. It dispatches by scope:

1. **HTTP** requests under `/mcp` → MCP Streamable HTTP app, after the auth gate in `apps/mcp_server/auth.py` (OAuth access token → personal access token → legacy static `CYT_MCP_TOKEN`). The authenticated user and its scopes are stashed **on the ASGI scope dict**, which is what tools read back per request; the `mcp_authenticated_user` ContextVar remains only for the stdio transport. See the attribution note below.
2. **WebSocket** connections → Channels `URLRouter` from `apps/tasks/routing.py` → `TaskConsumer` subscribes to `project_<id>` groups.
3. **Everything else** → standard Django HTTP (DRF + admin + OAuth URLs).

Because Daphne does not emit ASGI `lifespan` events, `asgi.py` synthesizes a startup message for the MCP app on the first `/mcp` request so its internal task group initializes. Do not remove `_ensure_mcp_lifespan`. Callers **await** a readiness `Event` that is set when the app answers `lifespan.startup.complete` — do not go back to sleeping a fixed interval: the previous version flipped an `_mcp_initialized` flag *before* starting the task and then slept 0.1s, so two requests arriving together at cold start both skipped the wait and the second hit `RuntimeError: Task group is not initialized` → 500.

### Data model (`apps/tasks/models.py`)

Core models: `Project`, `Column`, `Label`, `Task`, `View`, `RecurringTaskTemplate`, plus the Cyt OS bets trio `Bet` / `Metric` / `Checkin` (+ a `UserProfile` one-to-one for avatars).

- `Task.key` is a human-readable identifier like `CYT-001`, atomically generated per-project by `apps/tasks/id_generation.py` on first save. It is `unique=True` across the whole tracker and used as the DRF lookup field (`/api/tasks/<key>/`).
- `Task.position` is a float used for midpoint insertion within a column (LexoRank-lite). The `move` action on `TaskViewSet` and `_compute_position` in `views.py` implement drag-and-drop.
- A `post_save` signal on `Project` seeds the default Kanban columns (Backlog / Todo / In Progress / In Review / Done). `Column.is_done=True` on Done is how analytics/recurring defaults find the "completed" column.
- `View` is a saved Notion-style `filters` + `sort` preset (JSONFields). Views can be personal or `shared`.
- `RecurringTaskTemplate` is a blueprint, not a Task. Completing a generated instance does not affect the template's schedule.
- `Bet` is project-specific and belongs to a fixed **two-month period grid** anchored at 2026-07-01 (`apps/tasks/periods.py` — pure math, no stored periods; the frontend mirror is `frontend/src/lib/periods.ts`, keep them in sync). `Bet.save()` snaps any `period_start` onto the grid. `Task.bet` (SET_NULL) links a task to the bet it serves and must match the task's project (validated in `TaskWriteSerializer` + MCP; cleared on project move). A bet's `Metric`s track progress via append-only `Checkin` rows (optional numeric `value` and/or `note` — a check-in needs at least one). Bet/metric/check-in writes broadcast `bet.*` events into the project's Channels group.

### Shared filter/sort logic (`apps/tasks/query.py`)

`base_task_queryset()`, `apply_task_filters()`, `apply_task_sort()`, and `filter_and_sort_tasks()` are the **single source of truth** for task filtering and sorting. Both the DRF `TaskViewSet` (when resolving `?view=<id>`) and every MCP tool call through this module. Do not duplicate filter logic in either consumer — extend these helpers.

The filter dict shape matches what `View.filters` stores on disk (`{assignee, priority, labels, column, project, search}`). Sort entries look like `[{"field": "priority", "dir": "desc"}]`. Unknown filter keys are silently ignored so older saved views keep working.

### Real-time broadcasts (`apps/tasks/broadcast.py`)

Every DRF write path, MCP write tool, and the recurring-task generator calls `broadcast_task_event(project_id, event_type, payload)`. That pushes a `task.event` message into the `project_<id>` Channels group; `TaskConsumer` forwards it to browsers, which invalidate TanStack Query caches via `frontend/src/lib/ws.ts`.

**Cross-process catch**: Phase 1 uses the in-memory channel layer (no Redis), so the MCP stdio process and Daphne have disjoint channel layers. When `CYT_BROADCAST_URL` is set in the MCP process, `broadcast_task_event` POSTs to Daphne's `/api/internal/broadcast/` endpoint instead, which re-dispatches into Daphne's local channel layer. The endpoint requires `X-Cyt-Broadcast-Secret` to match `CYT_BROADCAST_SECRET` and refuses non-loopback callers. The consumer dispatch key must stay `task.event` because Channels converts dots to underscores when resolving the handler method name `task_event`.

### Recurring tasks (`apps/tasks/recurring.py`)

`generate_due_instances(now)` walks every active template whose `next_run_at <= now`, materializes one `Task` per missed occurrence (capped at `MAX_CATCHUP_PER_TEMPLATE = 50` per pass), advances `next_run_at`, and broadcasts `task.created`. Wrapped in `transaction.atomic()` + `select_for_update()` so concurrent calls serialize safely on SQLite.

Two triggers call this:

1. **Primary**: a systemd timer / cron running `python manage.py generate_recurring_tasks`.
2. **Safety net**: `LazyRecurringMiddleware` (in `MIDDLEWARE`) scans on HTTP requests if `RECURRING_LAZY_SCAN_INTERVAL_SECONDS` (600s) has elapsed since the last scan. Gated by a `locmem` cache entry so the hot path stays cheap.

`parse_schedule()` translates human presets (`daily`, `weekdays`, `weekly:mon,wed,fri`, `monthly:15`, etc.) into RFC-5545 RRULE strings; any string containing `FREQ=` passes through as a raw RRULE.

### MCP server (`apps/mcp_server/`)

`server.py` wires `FastMCP` tools that are thin async wrappers around sync helpers in `tools.py`, bridged via `sync_to_async`. Two transports:

- **stdio**: `python manage.py mcp_serve` — for Claude Desktop.
- **Streamable HTTP**: auto-mounted at `/mcp/` by `core/asgi.py` — for remote agents.

Authentication for the HTTP transport happens in `_handle_mcp` in `core/asgi.py`, **not** inside FastMCP — the SDK's DNS rebinding protection is disabled intentionally because we gate on the Bearer token ourselves. All credential logic lives in `apps/mcp_server/auth.py`, which accepts, in order: an OAuth access token (validated with DOT's own `AccessToken.is_valid(scopes)`, so expiry *and* scope are checked), an `McpAccessToken` personal token, then the legacy static `CYT_MCP_TOKEN`. It **fails closed**: a request with no `Authorization` header is rejected unless `MCP_ALLOW_ANONYMOUS` (defaults to `DEBUG`).

**Attribution is per-request, via the ASGI scope — not a ContextVar.** Over streamable HTTP the session manager spawns one long-lived task per session and anyio copies the context at *session-creation* time, so a module-level ContextVar is pinned to whoever opened the session and every later call on it reads that user. The SDK does thread the per-message Starlette `Request` through to tool handlers (`request_ctx`), and that `Request` wraps the very scope dict the gate annotated — so `server._get_mcp_user()` / `_get_mcp_scopes()` read `scope["cyt_mcp_user"]` / `["cyt_mcp_scopes"]` first and only fall back to the ContextVar for stdio. Don't reintroduce a ContextVar read in tool code.

Write **scope** enforcement is one choke point: `_ScopedFastMCP.call_tool` in `server.py` requires `write` for any tool not in `READ_ONLY_TOOLS`. That set lists the *reads*, so a tool added later and forgotten is guarded by default.

OAuth is `django-oauth-toolkit`. `core/urls.py` mounts only its `base_urlpatterns` — the server-rendered application/token management views are dropped (they duplicate `/settings/connections`), which is why `admin.py` sets `view_on_site = False` on `ApplicationAdmin`: `Application.get_absolute_url()` reverses one of the dropped routes. Around it:

- `core/oauth_meta.py` — single source for the public origin. Prefers `BACKEND_PUBLIC_URL`, else derives it from the request and forces HTTPS for non-loopback hosts. Used by both `.well-known` documents and the `/mcp` 401 challenge, which previously hardcoded `tm-api.cytsoftware.com`.
- `GET /.well-known/oauth-authorization-server[/mcp]` — RFC 8414. Advertises `S256` only, matching `PKCE_REQUIRED`.
- `GET /.well-known/oauth-protected-resource[/mcp]` — RFC 9728; named by the 401's `resource_metadata`.
- `POST /oauth/register/` — RFC 7591 dynamic registration. Validates redirect URIs (https, or http on loopback only, or an allowlisted custom scheme), rate-limits per IP, and **dedups public clients** so a reconnect doesn't mint another `Application` row. Confidential clients can't be deduped: DOT hashes `client_secret` on save, so an existing row's plaintext is unrecoverable — capture it *before* `save()` and return that.
- `apps/mcp_server/oauth_views.py` — `McpAuthorizationView` subclasses DOT's `AuthorizationView` and overrides exactly two things: `handle_no_permission` (redirect to the frontend login with an **absolute** `next`; Django's relative default resolves against the *frontend* origin and 404s) and `render_to_response` (redirect to `/oauth/consent` instead of DOT's template). Everything upstream is untouched, so `skip_authorization` and `REQUEST_APPROVAL_PROMPT="auto"` still short-circuit — which is what makes reconnects silent.
- `OAuthAuthorizeRequestView` backs that page. It talks to `get_oauthlib_core()` directly rather than subclassing `AuthorizationView` alongside DRF's `APIView` — `FormMixin.initial = {}` would shadow `APIView.initial()`. It re-validates from the **raw query string** on both GET and POST, so client parameters we don't model (`resource`, `nonce`, `claims`) pass through untouched and nothing echoed by the page is trusted.

`LOGIN_URL` points at the frontend (`/login`); in production `COOKIE_DOMAIN=.cytsoftware.com` lets the session cookie be shared between the frontend and backend subdomains.

#### Wiki body writes over MCP (`apps/wiki/content_ops.py`)

The wiki structure/metadata MCP tools (`create/update/delete/list/get_wiki_doc`) touch plain `Doc` rows. Writing the page **body** is different: the body is a slate-yjs CRDT and Python cannot faithfully encode it (`pycrdt` can't even bind the root `XmlText` slate-yjs uses). So the `set/append/insert_wiki_content` tools delegate Markdown↔CRDT encoding to a **frontend route** (`frontend/src/app/api/wiki/encode/route.ts`) that reuses the editor's exact `yjs` + `@slate-yjs/core` + `@platejs/markdown` (headless schema in `wiki-schema.ts`, kept in sync with `editor-kit.tsx`). The route returns an incremental update + new full state.

`apply_content` (a coroutine — it must run on Daphne's event loop) reads the current state (the live in-memory room doc if the page is open, else the `DocState` blob), calls the encoder, and on success applies the diff to the shared room doc + pushes a `create_update_message` into the `wiki_doc_<key>` group so open editors converge live, then persists the new state + snapshot and broadcasts a `wiki.updated` tree event. The HTTP MCP transport (in-process) awaits it directly; the stdio MCP process routes through `/api/internal/wiki/apply/` (loopback + `CYT_BROADCAST_SECRET`), which re-enters the loop via `async_to_sync`. Note the stock `YjsConsumer` does **not** auto-forward server-side doc mutations — the explicit `group_send` is required.

### Frontend data flow

`frontend/src/lib/api.ts` — `apiFetch` wrapper that auto-attaches the `csrftoken` cookie on unsafe methods and uses `credentials: "include"` throughout. Seed the CSRF cookie once on boot via `ensureCsrfCookie()` → `/api/auth/csrf/`.

`frontend/src/app/providers.tsx` — wraps the tree in `ThemeProvider`, a single `QueryClient` with `staleTime: 30s` / `refetchOnWindowFocus: false`, `ActiveProjectProvider`, and `TooltipProvider`. Query keys live in `frontend/src/lib/query-keys.ts`.

`frontend/src/lib/ws.ts` — per-project WebSocket subscriber with exponential-backoff reconnect; on every event it invalidates `taskListKey(projectId)` + `projectKey(projectId)` so TanStack refetches the visible view. One socket is mounted per project view, not globally.

`frontend/src/hooks/use-tasks.ts` — TanStack mutations for create/update/delete/move. `useMoveTask` does optimistic drag-and-drop positioning and rolls back on error.

### Frontend scroll invariant

`frontend/src/app/layout.tsx` enforces a **hard invariant**: the page itself must never scroll. `<html>` and `<body>` are `h-full` and `body` has `overflow-hidden`; the shell is `h-dvh flex flex-col lg:flex-row`. Every flex child that contains a scrollable descendant must carry `min-h-0` (or `min-w-0` for horizontal), otherwise flex refuses to shrink below content size and the page grows. This is the single biggest source of "why is my page scrolling" bugs — do not remove these classes without verifying, at every width:

```
document.documentElement.scrollHeight === window.innerHeight
document.body.scrollWidth <= window.innerWidth
```

Use `h-dvh`, never `h-screen`: `100vh` on mobile is the height with browser chrome *retracted*, so a `h-screen` shell hides its own bottom edge behind the URL bar — and because the body can't scroll, that content is unreachable rather than scrolled-to.

### Responsive conventions (TAS-061)

The breakpoint is `lg` (1024px); `max-lg:` is the mobile variant throughout. **Prefer CSS over JS branching** — `Shell.tsx` used to switch layouts on `useMediaQuery`, which server-renders `false`, so every device painted the mobile layout first and swapped on hydration. `useIsMobile()` (`hooks/use-media-query.ts`) exists for the few places the DOM must genuinely differ and returns a `hydrated` flag for exactly that reason.

- **Density is preserved on mobile.** Don't inflate `h-7`/`size-6` controls; add the `tap-target` utility, which grows the *hit area* to 44px via a pseudo-element without changing the painted size.
- **`hover-none:`** is a custom variant for `@media (hover: none)`. Every `opacity-0 group-hover:opacity-100` / `hidden group-hover:*` affordance needs a `hover-none:` counterpart or it is unreachable on touch.
- **`pt-safe` / `pb-safe`** apply `env(safe-area-inset-*)`; anything anchored to a screen edge needs them because `viewportFit: "cover"` is set.
- **Drag and drop does not work on touch.** `@atlaskit/pragmatic-drag-and-drop`'s element adapter is the native HTML5 drag API, which never fires from touch input. The board and `/focus` register `draggable()` only under `(pointer: fine)` and offer a long-press → bottom-sheet move instead (`components/kanban/MoveTaskSheet.tsx`, `hooks/use-long-press.ts`). Any new drag surface needs the same touch counterpart.
- **Standalone routes** (no app chrome) are listed in `STANDALONE_ROUTES` in `Shell.tsx`: `/login` and `/oauth/consent`. The consent page also needs its `next` preserved when the session has expired — `Shell` round-trips the full path + query through `/login?next=…`, because the whole authorization request lives in that query string.
- **`components/ui/sheet.tsx`** (Base UI, not Radix) is the primitive for edge-anchored overlays; **`components/layout/MasterDetail.tsx`** is the two-pane list⇄detail layout used by wiki, llm-wiki, drive, and both settings rails.
- Toolbars that scroll horizontally need `shrink-0` on their buttons — `overflow-x-auto` alone just lets flex children compress.

## Environment variables

Backend (see `core/settings.py`):

- `SECRET_KEY`, `ALLOWED_HOSTS`, `DEBUG`
- `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS` — comma-separated. Defaults target `http://localhost:3000`.
- `COOKIE_DOMAIN` — set to `.cytsoftware.com` in prod so session cookies work across the frontend/backend subdomain split. In prod (`DEBUG=False`) the settings automatically flip to `SameSite=None; Secure`.
- `CYT_MCP_TOKEN` — **legacy** shared Bearer for the HTTP MCP endpoint. Names no user, so writes fall back to a heuristic and user-scoped tools refuse. Prefer OAuth or a personal access token.
- `MCP_ALLOW_ANONYMOUS` — allow `/mcp` with no `Authorization` header. Defaults to `DEBUG`; an empty `CYT_MCP_TOKEN` no longer means "open".
- `BACKEND_PUBLIC_URL` — this deployment's public origin for OAuth metadata and the `/mcp` 401. Falls back to per-request derivation; set it in prod.
- `CYT_BROADCAST_SECRET` — shared secret for the cross-process broadcast bridge.
- `CYT_BROADCAST_URL` — set in the MCP stdio process so broadcasts reach Daphne via HTTP.
- `FRONTEND_URL` — used to build `LOGIN_URL` for OAuth redirects, and the default for `WIKI_ENCODE_URL`.
- `WIKI_ENCODE_URL` — frontend Markdown↔Yjs encoder route for wiki body writes (default `${FRONTEND_URL}/api/wiki/encode`). Must be reachable from the backend.
- `WIKI_ENCODE_SECRET` — shared secret the backend sends and the frontend route checks (default: falls back to `CYT_BROADCAST_SECRET`).
- `USESEND_API_KEY` — Bearer token for the [useSend](https://usesend.com) transactional email API. Empty = assignment emails disabled (skipped silently); everything else (in-app + WS notifications) still works.
- `USESEND_BASE_URL` — useSend API base (default `https://app.usesend.com`; requests POST to `${USESEND_BASE_URL}/api/v1/emails`).
- `USESEND_FROM_EMAIL` — the `from` address on assignment emails.
- `DB_DIR` — override the SQLite directory (so the Docker volume at `/app/db.sqlite3` persists).
- `MEDIA_DIR` — override `MEDIA_ROOT` (the on-disk upload directory). Defaults to `/app/media` inside the container — point a Dokploy volume at the chosen path to keep avatars across redeploys.
- `DJANGO_SUPERUSER_USERNAME` / `DJANGO_SUPERUSER_EMAIL` — consumed by `entrypoint.sh` for idempotent superuser creation.

Frontend:

- `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`)
- `NEXT_PUBLIC_WS_URL` (default `ws://localhost:8000`)
- `WIKI_ENCODE_SECRET` — server-only (not `NEXT_PUBLIC_`); the `/api/wiki/encode` route rejects requests whose `X-Cyt-Broadcast-Secret` header doesn't match. Empty = no check (local dev). Set it to the same value as the backend in prod.

The two `NEXT_PUBLIC_*` vars are baked in at `next build` time — the Dockerfile passes them as `ARG`s. `WIKI_ENCODE_SECRET` is read at runtime.

## Things to keep in mind

- Shared `apps/tasks/query.py` is mandatory — don't reimplement task filters in a viewset or MCP tool.
- `broadcast_task_event` is fire-and-forget and must not throw; any new write path needs a matching broadcast call to keep browsers in sync.
- `apps.tasks.notifications.notify_task_event` is the same fire-and-forget contract, for per-user `Notification` rows + the `ws/notifications/` push (verbs: `assigned`, `updated`, `moved`, `completed`, `deleted`). Every task write path that calls `broadcast_task_event` should also call this — recipients default to the task's assignees minus the acting user. It reuses `apps.tasks.broadcast`'s cross-process bridge (`broadcast_to_group`, `scope: "group"` on `/api/internal/broadcast/`) so it works from the MCP stdio process too.
- When adding a new MCP write tool, get the caller via `_get_mcp_user()` in `server.py` and pass it through to the underlying helper so writes are attributed correctly. Do **not** read `mcp_authenticated_user` directly — it is session-scoped, not request-scoped (see the MCP server section).
- Any new MCP tool that only reads must be added to `READ_ONLY_TOOLS` in `server.py`, or a read-only credential won't be able to call it. Anything omitted is treated as a write.
- `backend/apps/mcp_server/tests.py` is the one real Django test suite (`uv run python manage.py test apps.mcp_server`). Extend it when touching auth — every defect it covers shipped to production once already.
- `Task.save()` runs key generation inside a transaction only on first save; don't set `key` manually.
- Never write the wiki body (`DocState`/`content`) by re-encoding the CRDT in Python — it diverges from the editor. Route body writes through `apps.wiki.content_ops.apply_content` (→ the frontend encoder). If you add a node type to the editor, mirror it in `frontend/src/components/wiki/wiki-schema.ts` or MCP-written content will lose it.
- Phase 1 uses SQLite + `channels.layers.InMemoryChannelLayer` + `locmem` cache. Swapping to Postgres/Redis is planned — don't bake assumptions that would break the swap (e.g. SQLite-only SQL).
