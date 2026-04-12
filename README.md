# Cyt Task Tracker

A self-hosted, Linear-style task tracker for Cyt Software's internal work — with a **first-class MCP server** so Claude Desktop, Claude Code, Cursor, and any other MCP-compatible agent can read and mutate the board in real time alongside human users. Task changes from an LLM show up live on every connected browser.

> Phase 1 — the tracker is small, focused, and runs happily on SQLite + an in-memory channel layer. It is designed to graduate to Postgres + Redis without reshaping the code.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture at a glance](#architecture-at-a-glance)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
  - [Backend](#backend)
  - [Frontend](#frontend)
  - [Docker Compose](#docker-compose)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [MCP integration](#mcp-integration)
  - [Option 1 — Remote MCP over HTTP](#option-1--remote-mcp-over-http-recommended)
  - [Option 2 — Local stdio for Claude Desktop](#option-2--local-stdio-for-claude-desktop)
  - [Available MCP tools](#available-mcp-tools)
- [Recurring tasks](#recurring-tasks)
- [Real-time updates](#real-time-updates)
- [Project layout](#project-layout)
- [Deployment](#deployment)
- [Development notes](#development-notes)

---

## What it does

- **Kanban board** with drag-and-drop columns, labels, priorities, story points, assignees, and human-readable task keys (`CYT-001`).
- **Saved views** — Notion-style filter + sort presets that can be personal or shared; powers both the UI tabs and MCP `query_view`.
- **Recurring task templates** driven by RFC-5545 RRULEs (`daily`, `weekdays`, `weekly:mon,wed,fri`, `monthly:15`, or a raw `FREQ=…` string). A generator materializes missed occurrences safely, with a per-run catch-up cap.
- **Rich task descriptions** via a TipTap editor stored as JSON.
- **Real-time sync** — every write (from DRF, from MCP, from the recurring generator) fans out to connected browsers through Django Channels; TanStack Query invalidates and refetches automatically.
- **MCP server** exposing the tracker to AI agents over Streamable HTTP (Bearer token / OAuth 2.0) or stdio (Claude Desktop).
- **OAuth 2.0** with dynamic client registration (RFC 7591) and discovery metadata (RFC 8414) so MCP clients can self-provision credentials.

---

## Architecture at a glance

```
┌─────────────────┐       HTTP/WebSocket        ┌──────────────────────────┐
│  Next.js (3000) │ ◀──────────────────────────▶│  Daphne (8000)           │
│  React 19       │                             │  core/asgi.py dispatches │
│  TanStack Query │                             │   ├─ /api/*  → DRF       │
│  shadcn / BaseUI│                             │   ├─ /mcp/*  → MCP app   │
└─────────────────┘                             │   ├─ /oauth/ → OAuth     │
                                                │   ├─ /admin/ → Admin     │
                                                │   └─ /ws/*   → Channels  │
                                                └──────────────────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │  SQLite  +  InMemory layer  │
                                            │  LocMem cache (Phase 1)     │
                                            └─────────────────────────────┘
                                                           ▲
                                                           │
            ┌──────────────┐     stdio      ┌─────────────────────────────┐
            │ Claude / LLM │ ──────────────▶│ manage.py mcp_serve         │
            │  MCP client  │                │  (separate process, bridges │
            └──────────────┘                │   broadcasts via HTTP POST) │
                                            └─────────────────────────────┘
```

**One ASGI app, three protocols.** Daphne runs `core/asgi.py`, which routes by scope: HTTP `/mcp` requests hit a Bearer-token gate and the MCP Streamable HTTP app, WebSocket connections flow through Channels into `TaskConsumer`, everything else goes to the normal Django HTTP stack. The MCP HTTP endpoint accepts either an OAuth 2.0 Bearer (validated via `django-oauth-toolkit`, the resulting user is attributed to any writes) or a static `CYT_MCP_TOKEN`.

**Shared filter/sort logic.** `apps/tasks/query.py` is the single source of truth for task filtering and sorting. Both the DRF `TaskViewSet` (when resolving `?view=<id>`) and every MCP tool call through it, so a saved view produces identical results whether queried from the browser or an agent.

**Real-time fan-out.** Every write calls `broadcast_task_event()` which pushes into a `project_<id>` Channels group. Browsers subscribed to that project receive the event and invalidate their TanStack query cache, triggering a refetch.

**Cross-process bridge.** In Phase 1, stdio-mode MCP runs in a separate process from Daphne, so their in-memory Channels layers are disjoint. When `CYT_BROADCAST_URL` is set, `broadcast_task_event` POSTs to Daphne's `/api/internal/broadcast/` endpoint (authenticated with `X-Cyt-Broadcast-Secret`, restricted to loopback) which re-dispatches into Daphne's channel layer — so LLM writes still land on every browser live.

---

## Tech stack

| Layer    | Choice                                                                   |
| -------- | ------------------------------------------------------------------------ |
| Backend  | Python 3.12+, Django 6, DRF, Channels 4 (Daphne), `django-oauth-toolkit` |
| MCP      | `mcp[cli]` (FastMCP) over stdio and Streamable HTTP                      |
| Frontend | Next.js 16 (App Router, standalone), React 19, TypeScript                |
| UI       | Tailwind v4, shadcn (base-nova), Base UI, lucide-react                   |
| Data     | TanStack Query v5, TipTap v3, `@dnd-kit`                                 |
| Tooling  | `uv` for Python, `npm` for Node, ESLint                                  |
| Storage  | SQLite + `InMemoryChannelLayer` + `LocMemCache` (Phase 1)                |

---

## Getting started

Prerequisites:

- **Python 3.12+** and [`uv`](https://docs.astral.sh/uv/)
- **Node 22+** and `npm`
- Optional: Docker + Docker Compose

### Backend

```bash
cd backend
uv sync                                    # install deps from uv.lock
uv run python manage.py migrate             # create db.sqlite3
uv run python manage.py createsuperuser     # admin user
uv run python manage.py runserver           # Channels replaces runserver with Daphne
```

The backend is now serving:

- Admin: http://localhost:8000/admin/
- API: http://localhost:8000/api/
- Swagger: http://localhost:8000/api/schema/swagger/
- MCP: http://localhost:8000/mcp/
- WebSocket: ws://localhost:8000/ws/projects/\<id\>/

To run with Daphne directly (matches production):

```bash
uv run daphne -b 0.0.0.0 -p 8000 core.asgi:application
```

### Frontend

```bash
cd frontend
npm install
npm run dev         # http://localhost:3000
```

The first time you boot, go to http://localhost:3000/login and sign in with the superuser you created. The frontend seeds a CSRF cookie via `/api/auth/csrf/` and uses session authentication.

### Docker Compose

For a one-shot local spin-up (SQLite + both services):

```bash
docker compose up --build
```

`docker-compose.yml` is a local-dev / reference file. In production each service is deployed as a separate Dokploy application.

---

## Configuration

### Backend environment variables

| Variable                               | Purpose                                                                                                       | Default                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `SECRET_KEY`                           | Django secret key                                                                                             | insecure dev key              |
| `DEBUG`                                | Django debug flag (flips cookie SameSite/Secure)                                                              | `True`                        |
| `ALLOWED_HOSTS`                        | Comma list                                                                                                    | `*`                           |
| `CORS_ALLOWED_ORIGINS`                 | Comma list                                                                                                    | `http://localhost:3000`       |
| `CSRF_TRUSTED_ORIGINS`                 | Comma list                                                                                                    | `http://localhost:3000`       |
| `COOKIE_DOMAIN`                        | Cross-subdomain session cookie (e.g. `.cytsoftware.com`)                                                      | unset                         |
| `FRONTEND_URL`                         | Used to build `LOGIN_URL` for OAuth redirects                                                                 | `http://localhost:3000`       |
| `CYT_MCP_TOKEN`                        | Static Bearer for `/mcp/`; empty = open (dev only)                                                            | unset                         |
| `CYT_BROADCAST_SECRET`                 | Shared secret for the cross-process broadcast bridge                                                          | `dev-broadcast-secret…`       |
| `CYT_BROADCAST_URL`                    | URL the stdio MCP process POSTs broadcasts to                                                                 | `http://127.0.0.1:8000/api/internal/broadcast/` |
| `DB_DIR`                               | Override SQLite directory (Docker volume mount)                                                               | `backend/`                    |
| `DJANGO_SUPERUSER_USERNAME` / `EMAIL`  | Idempotent superuser creation in `entrypoint.sh`                                                              | unset                         |

### Frontend environment variables

| Variable               | Purpose                       | Default                 |
| ---------------------- | ----------------------------- | ----------------------- |
| `NEXT_PUBLIC_API_URL`  | Backend HTTP base             | `http://localhost:8000` |
| `NEXT_PUBLIC_WS_URL`   | Backend WebSocket base        | `ws://localhost:8000`   |

Both frontend vars are baked in at `next build` time (Dockerfile passes them as `ARG`s).

---

## HTTP API

The REST API is mounted at `/api/`. Endpoints are session-authenticated; unsafe methods require the `X-CSRFToken` header (the frontend reads it from the `csrftoken` cookie seeded by `/api/auth/csrf/`).

Auth:

```
GET  /api/auth/csrf/        # seed csrftoken cookie
POST /api/auth/login/       # {username, password}
POST /api/auth/logout/
GET  /api/auth/me/          # current user
PATCH /api/auth/me/         # update avatar_url
```

Resources (all standard DRF CRUD):

```
/api/projects/
/api/projects/<id>/columns/
/api/projects/<id>/labels/
/api/columns/
/api/labels/
/api/tasks/                  # ?project=<id>&view=<id>
/api/tasks/<key>/            # lookup by human key, e.g. CYT-001
/api/tasks/<key>/move/       # {column_id, before_id?, after_id?, position?}
/api/views/
/api/recurring-tasks/
/api/recurring-tasks/<id>/pause/
/api/recurring-tasks/<id>/resume/
/api/recurring-tasks/<id>/preview/   # {count}
/api/users/
```

Schema / docs:

```
/api/schema/               # OpenAPI 3 (drf-spectacular)
/api/schema/swagger/       # Swagger UI
```

OAuth 2.0:

```
/.well-known/oauth-authorization-server   # RFC 8414 discovery
/oauth/register/                           # RFC 7591 dynamic client registration
/oauth/authorize/                          # django-oauth-toolkit
/oauth/token/
/oauth/revoke_token/
/oauth/introspect/
```

---

## MCP integration

The MCP server exposes the task tracker to AI agents. Every write path inside an MCP tool runs inside `transaction.atomic` and fires a real-time broadcast, so LLM-driven changes show up live on browsers just like human edits.

### Option 1 — Remote MCP over HTTP (recommended)

Already running. When Daphne is up, the MCP endpoint is served at:

```
http://localhost:8000/mcp/
```

Set `CYT_MCP_TOKEN` in the environment and connect clients with a matching `Authorization: Bearer <token>` header. An MCP client config (e.g. `.mcp.json`) looks like:

```json
{
  "mcpServers": {
    "cyt-task-tracker": {
      "type": "http",
      "url": "https://tm-api.cytsoftware.com/mcp",
      "headers": {
        "Authorization": "Bearer <CYT_MCP_TOKEN>"
      }
    }
  }
}
```

For per-user attribution, use OAuth 2.0 instead. Create a confidential OAuth app once:

```bash
uv run python manage.py create_mcp_oauth_app
```

(This runs idempotently from `entrypoint.sh`, so on Docker it happens on every deploy.) The command prints a `client_id` / `client_secret`. Point your MCP client at the discovery URL `/.well-known/oauth-authorization-server` and it will pick up the `/oauth/authorize/` and `/oauth/token/` endpoints automatically. Clients that support [RFC 7591 dynamic client registration](https://datatracker.ietf.org/doc/html/rfc7591) (Claude Desktop, Cursor, etc.) can self-provision a client via `POST /oauth/register/` without running the management command.

When an MCP request arrives with a valid OAuth Bearer token, writes are attributed to that user (`reporter`, `created_by`).

### Option 2 — Local stdio for Claude Desktop

```bash
uv run python manage.py mcp_serve
```

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "cyt-task-tracker": {
      "command": "/abs/path/to/backend/.venv/bin/python",
      "args": ["/abs/path/to/backend/manage.py", "mcp_serve"],
      "env": {
        "DJANGO_SETTINGS_MODULE": "core.settings",
        "CYT_BROADCAST_URL": "http://127.0.0.1:8000/api/internal/broadcast/",
        "CYT_BROADCAST_SECRET": "dev-broadcast-secret-change-me"
      }
    }
  }
}
```

The `CYT_BROADCAST_URL` var is what routes LLM-fired broadcasts through the loopback HTTP bridge into Daphne's in-memory channel layer — without it, Claude Desktop edits would land in the DB but your browser wouldn't see them update live.

### Available MCP tools

| Tool                     | Description                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| `list_projects`          | List all projects.                                                                |
| `list_users`             | List active users (for assignee lookups).                                         |
| `list_tasks`             | Filter by project / assignee / priority / labels / column / limit.                |
| `get_task`               | Fetch a task (+ description) by human key.                                        |
| `create_task`            | Create a task. Defaults to the first non-done column if `column` is omitted.      |
| `update_task`            | Partial update — omitted fields are untouched.                                    |
| `move_task`              | Move to a column, with `"top"` / `"bottom"` / explicit `position`.                |
| `delete_task`            | Delete by human key.                                                              |
| `list_views`             | List saved views, optionally scoped to a project.                                 |
| `query_view`             | Return the tasks a saved view resolves to (same filter logic as the DRF viewset). |
| `create_recurring_task`  | Create a template. Accepts presets or raw RRULEs.                                 |
| `list_recurring_tasks`   | List templates, optionally filtered by project / active flag.                     |
| `update_recurring_task`  | Update template fields; `schedule`/`dtstart` changes recompute `next_run_at`.     |
| `pause_recurring_task`   | Deactivate a template.                                                            |
| `resume_recurring_task`  | Reactivate and recompute next run.                                                |
| `delete_recurring_task`  | Delete a template. Generated tasks remain.                                        |
| `preview_recurring_task` | Preview the next N scheduled occurrences without creating tasks.                  |

---

## Recurring tasks

Templates are RRULE-driven blueprints that generate concrete `Task` instances on schedule. Completing a generated instance does **not** advance the template's clock — the schedule is managed independently.

Schedule input accepts human-friendly presets or a raw RRULE:

```
daily                          → FREQ=DAILY
weekdays                       → FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
weekly                         → FREQ=WEEKLY
weekly:mon,wed,fri             → FREQ=WEEKLY;BYDAY=MO,WE,FR
monthly                        → FREQ=MONTHLY
monthly:15                     → FREQ=MONTHLY;BYMONTHDAY=15
yearly                         → FREQ=YEARLY
FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR    (any raw RRULE passes through)
```

Two triggers run the generator:

1. **Primary** — a systemd timer / cron running:

   ```bash
   uv run python manage.py generate_recurring_tasks
   ```

2. **Safety net** — `LazyRecurringMiddleware` scans on HTTP requests if more than `RECURRING_LAZY_SCAN_INTERVAL_SECONDS` (default 600s) has elapsed since the last scan. Gated by a locmem cache entry so the hot path stays cheap.

A single pass caps at `MAX_CATCHUP_PER_TEMPLATE = 50` materializations per template, so a pathological `FREQ=HOURLY` template with a `dtstart` years in the past can't flood the board on its first tick — remaining occurrences fire on subsequent passes.

---

## Real-time updates

Browsers subscribe to `ws://.../ws/projects/<project_id>/`. Every write path (DRF viewset, MCP tool, recurring generator) calls `broadcast_task_event(project_id, event_type, payload)`, which fans out to the `project_<id>` group with `type="task.event"`. `TaskConsumer.task_event` forwards the payload to the browser; `frontend/src/lib/ws.ts` invalidates the TanStack cache for the project, which triggers a refetch of the active view.

Event types: `task.created`, `task.updated`, `task.moved`, `task.deleted`.

The in-memory channel layer is process-local, so the stdio MCP process uses an HTTP bridge (`/api/internal/broadcast/`) to deliver events into Daphne's layer where the browsers actually listen. The endpoint requires `X-Cyt-Broadcast-Secret` and refuses non-loopback callers.

---

## Project layout

```
tm/
├── backend/
│   ├── core/
│   │   ├── asgi.py          # three-protocol ASGI dispatcher
│   │   ├── settings.py
│   │   └── urls.py          # OAuth metadata + dynamic registration shims
│   ├── apps/
│   │   ├── tasks/
│   │   │   ├── models.py       # Project, Column, Label, Task, View, RecurringTaskTemplate
│   │   │   ├── views.py        # DRF viewsets, auth, internal broadcast
│   │   │   ├── serializers.py
│   │   │   ├── query.py        # single source of truth for task filter/sort
│   │   │   ├── recurring.py    # RRULE parsing, generator, previews
│   │   │   ├── broadcast.py    # fire-and-forget channel layer pushes + HTTP bridge
│   │   │   ├── consumers.py    # TaskConsumer (WebSocket)
│   │   │   ├── routing.py      # ws URL patterns
│   │   │   ├── middleware.py   # LazyRecurringMiddleware
│   │   │   ├── filters.py      # django-filter TaskFilter
│   │   │   ├── id_generation.py  # atomic CYT-001 key allocator
│   │   │   └── management/commands/generate_recurring_tasks.py
│   │   └── mcp_server/
│   │       ├── server.py       # FastMCP tool registration
│   │       ├── tools.py        # pure-sync tool implementations
│   │       └── management/commands/{mcp_serve.py, create_mcp_oauth_app.py}
│   ├── manage.py
│   ├── Dockerfile
│   ├── entrypoint.sh           # migrate → bootstrap OAuth app → daphne
│   └── pyproject.toml / uv.lock
├── frontend/
│   ├── src/
│   │   ├── app/                # Next.js App Router
│   │   │   ├── layout.tsx      # ⚠ hard no-page-scroll invariant (see comments)
│   │   │   ├── providers.tsx   # QueryClient + ThemeProvider + ActiveProjectProvider
│   │   │   ├── login/
│   │   │   └── board/
│   │   ├── components/
│   │   │   ├── kanban/         # Column, Card
│   │   │   ├── task/           # TaskDialog, TaskPanel, DescriptionEditor, RecurrencePicker
│   │   │   ├── list/
│   │   │   ├── views/
│   │   │   ├── project/
│   │   │   ├── label/
│   │   │   ├── layout/         # Shell, sidebar
│   │   │   └── ui/             # shadcn primitives (base-nova)
│   │   ├── hooks/              # use-tasks, use-users
│   │   └── lib/
│   │       ├── api.ts          # fetch wrapper + CSRF
│   │       ├── auth.ts
│   │       ├── ws.ts           # per-project WebSocket subscriber
│   │       ├── query-keys.ts
│   │       ├── types.ts
│   │       ├── rrule.ts
│   │       └── active-project.tsx
│   ├── next.config.ts          # output: "standalone"
│   ├── components.json         # shadcn config (style: base-nova)
│   └── Dockerfile
├── docker-compose.yml          # local reference; prod = separate Dokploy apps
└── .mcp.json                   # example MCP client config
```

---

## Deployment

Each service is deployed as an independent Dokploy application. The backend container:

1. Runs `uv run python manage.py migrate --noinput`
2. Creates a superuser from `DJANGO_SUPERUSER_USERNAME` / `DJANGO_SUPERUSER_EMAIL` (idempotent)
3. Calls `uv run python manage.py create_mcp_oauth_app` (idempotent)
4. Starts `uv run daphne -b 0.0.0.0 -p 8000 core.asgi:application`

Production quirks handled by settings:

- `/.well-known/oauth-authorization-server` forces `https://` in its response when the host is non-loopback, so Traefik's http-to-backend termination doesn't leak through to MCP clients.
- When `DEBUG=False`, session and CSRF cookies automatically flip to `SameSite=None; Secure` so the frontend (`tm.cytsoftware.com`) and backend (`tm-api.cytsoftware.com`) can share auth across subdomains. Set `COOKIE_DOMAIN=.cytsoftware.com` so both subdomains read the cookie.
- The frontend Dockerfile passes `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` as build args so Next.js can bake them into the bundle.

---

## Development notes

- **Don't duplicate filter logic.** Both DRF and MCP go through `apps/tasks/query.py`. Extend those helpers instead of reinventing filters in a viewset or tool.
- **Every new write path needs a broadcast.** Call `broadcast_task_event(project_id, type, payload)` after any mutation, or the browser will go stale.
- **MCP write attribution.** New MCP write tools should read the authenticated user via `_get_mcp_user()` in `server.py` and pass it through — otherwise OAuth-authenticated writes land without an author.
- **Task keys are generated in `save()`.** Never set `Task.key` manually; the first save atomically allocates the next per-project counter.
- **Frontend no-page-scroll invariant.** `html`/`body` are `h-full overflow-hidden`. Every flex child containing a scrollable descendant must carry `min-h-0` (or `min-w-0` for horizontal). Violating this makes the page grow unexpectedly — see the comment block at the top of `frontend/src/app/layout.tsx`.
- **Phase 1 assumptions.** SQLite + `InMemoryChannelLayer` + `LocMemCache`. The code is written to graduate to Postgres + Redis without reshaping — don't bake in SQLite-only SQL or single-process assumptions.

### Useful commands

```bash
# Backend
uv run python manage.py migrate
uv run python manage.py makemigrations tasks
uv run python manage.py createsuperuser
uv run python manage.py generate_recurring_tasks   # fire due recurring templates
uv run python manage.py mcp_serve                   # stdio MCP for Claude Desktop
uv run python manage.py create_mcp_oauth_app        # bootstrap OAuth app

# Frontend
npm run dev
npm run build
npm run lint
```
