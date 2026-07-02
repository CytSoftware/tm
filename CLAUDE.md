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

1. **HTTP** requests under `/mcp` → MCP Streamable HTTP app, after a custom Bearer-token check (OAuth access token via `django-oauth-toolkit`, falling back to a static `CYT_MCP_TOKEN`). The authenticated user is stashed in a `ContextVar` (`mcp_authenticated_user`) that MCP tools read to attribute writes.
2. **WebSocket** connections → Channels `URLRouter` from `apps/tasks/routing.py` → `TaskConsumer` subscribes to `project_<id>` groups.
3. **Everything else** → standard Django HTTP (DRF + admin + OAuth URLs).

Because Daphne does not emit ASGI `lifespan` events, `asgi.py` synthesizes a startup message for the MCP app on the first `/mcp` request so its internal task group initializes. Do not remove `_ensure_mcp_lifespan`.

### Data model (`apps/tasks/models.py`)

Six models: `Project`, `Column`, `Label`, `Task`, `View`, `RecurringTaskTemplate` (+ a `UserProfile` one-to-one for avatars).

- `Task.key` is a human-readable identifier like `CYT-001`, atomically generated per-project by `apps/tasks/id_generation.py` on first save. It is `unique=True` across the whole tracker and used as the DRF lookup field (`/api/tasks/<key>/`).
- `Task.position` is a float used for midpoint insertion within a column (LexoRank-lite). The `move` action on `TaskViewSet` and `_compute_position` in `views.py` implement drag-and-drop.
- A `post_save` signal on `Project` seeds the default Kanban columns (Backlog / Todo / In Progress / In Review / Done). `Column.is_done=True` on Done is how analytics/recurring defaults find the "completed" column.
- `View` is a saved Notion-style `filters` + `sort` preset (JSONFields). Views can be personal or `shared`.
- `RecurringTaskTemplate` is a blueprint, not a Task. Completing a generated instance does not affect the template's schedule.

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

Authentication for the HTTP transport is done in `_handle_mcp` in `core/asgi.py`, **not** inside FastMCP — the SDK's built-in DNS rebinding protection is disabled intentionally because we gate on the Bearer token ourselves.

OAuth is handled by `django-oauth-toolkit` mounted at `/oauth/`, plus two shim views in `core/urls.py`:

- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata (forces HTTPS when behind a reverse proxy for non-localhost hosts).
- `POST /oauth/register/` — RFC 7591 dynamic client registration, so MCP clients can self-provision a `client_id`/`client_secret`.

`LOGIN_URL` points at the frontend (`/login`) so OAuth's "not logged in" redirect hands off cleanly; in production, `COOKIE_DOMAIN=.cytsoftware.com` lets the session cookie be shared between frontend and backend subdomains.

#### Wiki body writes over MCP (`apps/wiki/content_ops.py`)

The wiki structure/metadata MCP tools (`create/update/delete/list/get_wiki_doc`) touch plain `Doc` rows. Writing the page **body** is different: the body is a slate-yjs CRDT and Python cannot faithfully encode it (`pycrdt` can't even bind the root `XmlText` slate-yjs uses). So the `set/append/insert_wiki_content` tools delegate Markdown↔CRDT encoding to a **frontend route** (`frontend/src/app/api/wiki/encode/route.ts`) that reuses the editor's exact `yjs` + `@slate-yjs/core` + `@platejs/markdown` (headless schema in `wiki-schema.ts`, kept in sync with `editor-kit.tsx`). The route returns an incremental update + new full state.

`apply_content` (a coroutine — it must run on Daphne's event loop) reads the current state (the live in-memory room doc if the page is open, else the `DocState` blob), calls the encoder, and on success applies the diff to the shared room doc + pushes a `create_update_message` into the `wiki_doc_<key>` group so open editors converge live, then persists the new state + snapshot and broadcasts a `wiki.updated` tree event. The HTTP MCP transport (in-process) awaits it directly; the stdio MCP process routes through `/api/internal/wiki/apply/` (loopback + `CYT_BROADCAST_SECRET`), which re-enters the loop via `async_to_sync`. Note the stock `YjsConsumer` does **not** auto-forward server-side doc mutations — the explicit `group_send` is required.

### Frontend data flow

`frontend/src/lib/api.ts` — `apiFetch` wrapper that auto-attaches the `csrftoken` cookie on unsafe methods and uses `credentials: "include"` throughout. Seed the CSRF cookie once on boot via `ensureCsrfCookie()` → `/api/auth/csrf/`.

`frontend/src/app/providers.tsx` — wraps the tree in `ThemeProvider`, a single `QueryClient` with `staleTime: 30s` / `refetchOnWindowFocus: false`, `ActiveProjectProvider`, and `TooltipProvider`. Query keys live in `frontend/src/lib/query-keys.ts`.

`frontend/src/lib/ws.ts` — per-project WebSocket subscriber with exponential-backoff reconnect; on every event it invalidates `taskListKey(projectId)` + `projectKey(projectId)` so TanStack refetches the visible view. One socket is mounted per project view, not globally.

`frontend/src/hooks/use-tasks.ts` — TanStack mutations for create/update/delete/move. `useMoveTask` does optimistic drag-and-drop positioning and rolls back on error.

### Frontend scroll invariant

`frontend/src/app/layout.tsx` enforces a **hard invariant**: the page itself must never scroll. `<html>` and `<body>` are `h-full` and `body` has `overflow-hidden`; the shell is `h-screen flex flex-col`. Every flex child that contains a scrollable descendant must carry `min-h-0` (or `min-w-0` for horizontal), otherwise flex refuses to shrink below content size and the page grows. This is the single biggest source of "why is my page scrolling" bugs — do not remove these classes without verifying `document.documentElement.scrollHeight === window.innerHeight`.

## Environment variables

Backend (see `core/settings.py`):

- `SECRET_KEY`, `ALLOWED_HOSTS`, `DEBUG`
- `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS` — comma-separated. Defaults target `http://localhost:3000`.
- `COOKIE_DOMAIN` — set to `.cytsoftware.com` in prod so session cookies work across the frontend/backend subdomain split. In prod (`DEBUG=False`) the settings automatically flip to `SameSite=None; Secure`.
- `CYT_MCP_TOKEN` — static Bearer for the HTTP MCP endpoint. Empty = open (local dev only).
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
- When adding a new MCP write tool, read the user from `mcp_authenticated_user.get(None)` via `_get_mcp_user()` in `server.py` and pass it through to the underlying helper so writes are attributed correctly.
- `Task.save()` runs key generation inside a transaction only on first save; don't set `key` manually.
- Never write the wiki body (`DocState`/`content`) by re-encoding the CRDT in Python — it diverges from the editor. Route body writes through `apps.wiki.content_ops.apply_content` (→ the frontend encoder). If you add a node type to the editor, mirror it in `frontend/src/components/wiki/wiki-schema.ts` or MCP-written content will lose it.
- Phase 1 uses SQLite + `channels.layers.InMemoryChannelLayer` + `locmem` cache. Swapping to Postgres/Redis is planned — don't bake assumptions that would break the swap (e.g. SQLite-only SQL).
