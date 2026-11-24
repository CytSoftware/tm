# Access by module × project

Status: planned 2026-11-24. Replaces the binary staff / non-staff split in
`apps/tasks/access.py`.

## The model

A user has two independent lists, both edited by staff on one settings page:

- **Modules** — `UserProfile.modules`, a list of module keys.
- **Projects** — `Project.members` (the existing M2M, unchanged).

A non-staff user sees a row only when they hold the module **and** (for
project-scoped modules) the row's project is one of theirs. Staff and
superusers (`has_full_access`) bypass everything, exactly as today. Rows with
no project stay staff-only, as today.

One module list per user, not per project: "Tasks on" + projects A, B = tasks
of A and B. A per-project module list is deliberately out of scope.

## Modules

| Key | Sidebar | Scope | REST prefixes | Notes |
|---|---|---|---|---|
| `tasks` | Home, Tasks, To Review | module + project | `/api/tasks/`, `/api/columns/` (read), `/api/labels/`, `/api/views/`, `/api/recurring-tasks/`, `/api/me/focus/`, `/api/integrations/github/pull-requests/` | Comments, focus, recurring all follow the task's project. PRs filtered to repos of visible projects (`ProjectRepository`). |
| `bets` | Bets | module only | `/api/bets/`, `/api/metrics/`, `/api/checkins/` | Module holders see all projects' bets. |
| `analytics` | Analytics | module only | `/api/analytics/` (throughput, completions); `/api/settings/staleness/` GET for the board's stale badges goes under `tasks`, writes stay staff-only | Module holders see all projects' numbers. |
| `crm` | CRM → Leads, Activity, People, Companies | module + project | `/api/crm/leads/`, `/api/crm/updates/`, `/api/crm/contacts/`, `/api/crm/activity/`, `/api/crm/steps/`, `/api/crm/projects/` | See "CRM scoping". |
| `billing` | CRM → Billing, Licences | module + project | `/api/crm/payments/`, `/api/crm/licences/` | Longest prefix wins over `/api/crm/`. |
| `meetings` | Meetings | module + project | `/api/meetings/`, `/api/meeting-entities/` | Existing project scoping stays. |
| `reports` | Reports | module + project | `/api/reports/` | Existing scoping stays; delete stays staff-only. |
| `wiki` | Wiki | module gate + existing rules | `/api/wiki-docs/` | Keep `visible_doc_ids` behind the gate (no widening). |
| `llm_wiki` | LLM Wiki | module gate + existing rules | `/api/knowledge/` | Keep `visible_knowledge_slugs` behind the gate. |
| `drive` | Drive | module gate + existing rules | `/api/drive/` (shares stay staff-only) | Keep `can_reach_drive` behind the gate. |
| `operations` | Events, Routines, Services, Monitoring | module only | `/api/routines/`, `/api/events/`, `/api/event-sources/`, `/api/services/`, monitoring endpoints | Find monitoring's endpoints from `frontend/src/app/monitoring`. |

**Always allowed** for any signed-in user (no module): `/api/auth/`,
`/api/users/` (read), `/api/projects/` (read, already scoped to membership),
`/api/notifications/`, `/api/uploads/`, `/api/external/tasks/` (POST, current
rule), `/settings/quick-actions`.

**Staff-only** (not in the matrix): project create/edit/delete, column and
staleness configuration, outgoing webhooks (`/api/webhooks/` — a global
webhook would leak every project's task events), GitHub settings, MCP
token / OAuth management UI, Drive shares, report delete, the new access API.

## Backend

### 1. Data

- `UserProfile.modules = JSONField(default=list, blank=True)`.
- Data migration: every existing **non-staff** user gets
  `["meetings", "reports", "wiki", "llm_wiki", "drive"]` — exactly what they
  reach today. Staff get `[]` (they bypass). New users default to `[]` (fail
  closed).
- Update `Project.members.help_text` to describe the new meaning.

### 2. `apps/tasks/access.py` — the one source of truth

- `MODULES` tuple and `PROJECT_SCOPED = {"tasks", "crm", "billing", "meetings", "reports"}`.
- `user_modules(user) -> frozenset[str]` — all modules for staff; the profile
  list (validated against `MODULES`) otherwise. Cache per request on the user
  object (`user._cyt_modules`) — it is read many times per request.
- `has_module(user, module) -> bool`.
- `visible_project_ids(user, module)` — **`module` becomes a required
  argument**. Returns `None` for staff, `set()` without the module, the
  membership set otherwise. Making it required forces every one of the ~77
  call sites to be revisited; do not give it a default.
- `can_see_project`, `restrict_to_projects`, `scope_for_caller` take `module`
  the same way. `visible_doc_ids` / `visible_drive_keys` /
  `visible_knowledge_slugs` return empty without `wiki` / `drive` / `llm_wiki`.
- Replace `NON_STAFF_API` with `API_MODULES: tuple[(prefix, module | None, methods | None)]`
  (`None` module = always allowed), matched **longest prefix first**.
  `NonStaffAccessMiddleware` (rename to `ModuleAccessMiddleware`) refuses an
  unlisted prefix (fail closed, unchanged) and a listed one whose module the
  user lacks.
- Update the module docstring.

### 3. Per-app scoping

Walk every call site of the helpers above and every viewset in the REST table.

- **Tasks.** `TaskViewSet`, `ColumnViewSet`, `LabelViewSet`, `ViewViewSet`,
  `RecurringTaskViewSet`, focus, comments: scope with `module="tasks"`. Writes
  must check the *target* project too (create, project move, recurring
  template create/update, label create). Column create/update/delete and
  reorder stay staff-only (`StaffOnlyActions`). `TaskWriteSerializer` bet
  validation stays as is.
- **Bets / analytics.** Module only: `BetViewSet`, `MetricViewSet`,
  `CheckinViewSet`, `ThroughputView`, `WeeklyCompletionsView` are gated by
  the middleware; remove any membership filter they apply to non-staff, or
  keep it — decide by reading them, but the documented rule is module-only.
- **CRM scoping** (`apps/crm/query.py` gains a `user` parameter on every
  `filter_*` and base queryset; `apps/crm/views.py` passes `request.user`,
  detail routes included — today they use the unscoped base queryset):
  - Lead: `project_id ∈ visible_project_ids(user, "crm")`.
  - Update: its lead is visible. Updates with no lead (people-only) are
    staff-only.
  - Contact (`Entity`): visible when linked to a visible lead or update (the
    same joins `filter_contacts` already uses for `project`). Apply this to
    search too — today a search reaches every entity. Create is allowed; a new
    contact shows once it is on a visible lead.
  - `post_update(next_step=…)` needs a visible lead; the step task is CRM data
    and shows in CRM without the `tasks` module.
  - `CrmProjectsView` returns only visible projects.
- **Billing.** `filter_payments` / `filter_licences` + detail + writes scoped
  with `module="billing"`. Linking a payment/licence to a lead the user can't
  see in CRM: allow the id (billing doesn't need CRM), but don't serialize the
  lead's details unless the user has `crm`.
- **Meetings / reports / wiki / LLM wiki / Drive.** Pass the module to the
  existing helpers. `MeetingViewSet.staff_only_actions` keeps `create` and
  `destroy`; `action_item_create_task` and `tasks` become allowed with the
  `tasks` module + a visible target project.
- **Cross-module links — hide on the server**, never only in the UI:
  - `TaskReadSerializer.get_sources`: lead source only with `crm` + visible
    lead; meeting sources only with `meetings` + visible meeting.
  - Meeting detail: linked tasks only with `tasks` + visible project.
  - CRM lead/update detail: the step task is shown (CRM data); meeting link
    only with `meetings` + visible meeting.
  - Entity detail via `/api/meeting-entities/`: CRM-only contact fields
    (phone, emails, LinkedIn) only with `crm`. Check what
    `EntityViewSet`'s serializer exposes today.
  - Notifications: list only rows whose task the user can still see.
- **`/api/auth/me/`**: add `modules: list[str]` (all modules for staff).
- **New staff-only access API** — `apps/tasks/access_views.py`:
  - `GET /api/access/` → `{modules: [...], projects: [{id, prefix, name}], users: [{id, username, name, is_staff, modules, project_ids}]}` (active users).
  - `PATCH /api/access/users/<id>/` with `{modules?, project_ids?}` → validates
    module keys and project ids, writes `UserProfile.modules` and
    `Project.members`, returns the user row. Refuse editing staff rows
    (they bypass; editing would mislead).
  - Not in `API_MODULES`, so non-staff are refused by the middleware.

### 4. WebSockets

- `TaskConsumer` (`project_<id>`): allow with `tasks` + membership. (It also
  carries `bet.*` events; bets-only users get no live updates — acceptable.)
- `MeetingsConsumer`: `meetings`. `CrmConsumer`: `crm` or `billing`.
  `WikiTreeConsumer` / `WikiDocConsumer`: `wiki` (doc consumer keeps its
  per-doc check). `NotificationConsumer`: always.
- Close code 4403 for "no module", as the project socket does today.

### 5. MCP (`apps/mcp_server/server.py`)

- Replace `NON_STAFF_TOOLS` with `TOOL_MODULES: dict[str, str | None]` covering
  every tool a non-staff user may call (`None` = always, e.g. `list_projects`,
  `list_users`). Tools absent from the map stay staff-only — keep that
  default. `_ScopedFastMCP.call_tool` refuses a non-staff caller lacking the
  tool's module, with a message naming the module.
- Map: task/comment/label/view/recurring/focus tools → `tasks`;
  column create/update/delete/reorder → staff-only (absent);
  bet/metric/checkin → `bets`; `get_throughput`, `get_weekly_completions` →
  `analytics`; leads/updates/contacts/`complete_next_step`/`list_crm_activity`
  → `crm`; payments/licences → `billing`; meeting tools currently in
  `NON_STAFF_TOOLS` → `meetings` (plus `create_task_from_meeting_action_item`
  and `link_meeting_task`, which also need `tasks`); `list_reports`,
  `get_report` → `reports`; wiki tools → `wiki`; knowledge tools currently
  allowed → `llm_wiki`; drive tools currently allowed → `drive`; routine
  tools → `operations`. Staff-only: `upsert_meeting`, `delete_meeting`,
  `update_meeting_entity`, `merge_meeting_entities`, `publish_report`,
  webhook tools, `knowledge_sources`, `knowledge_reindex`, column writes.
- Every newly opened tool must scope by the caller: task, bet, CRM and billing
  helpers were staff-only, so many do **not** take `mcp_user` yet. Each one
  needs `mcp_user=_get_mcp_user()` from its wrapper and a scoped queryset
  (`scope_for_caller(qs, mcp_user, module)`), including resolving references
  by key (`get_task("X-1")` on an invisible project → "not found", not 403).
  `apps/crm/mcp_tools.py` passes `user` into the new `crm/query.py` params.
- `mcp_user=None` (legacy token, stdio) stays unrestricted.

### 6. Tests — `apps/tasks/test_access.py`

One table-driven test, not a framework: users {staff, member-with-module,
member-without-module, module-without-membership} × each module's list
endpoint → expected status / row count. Plus:

- Middleware: unlisted prefix → 403; `/api/crm/payments/` needs `billing`
  even with `crm`.
- CRM contact search doesn't return an entity only linked to an invisible
  project.
- Task `sources` hide a lead for a user without `crm`.
- Access API: non-staff → 403; PATCH writes modules + memberships; unknown
  module → 400.
- MCP: `call_tool` refuses `list_tasks` without `tasks`; `get_task` on an
  invisible project raises not-found.
- Data migration: existing non-staff keeps meetings/wiki/reports/drive/llm_wiki.

Run `uv run python manage.py test` (all apps) — `apps.mcp_server` tests must
stay green.

## Frontend

- `lib/types.ts`: `Me.modules: ModuleKey[]`.
- `lib/auth.ts`: replace `NON_STAFF_ROUTES` with `ROUTE_MODULES`
  (`/board`, `/reviews`, `/focus` → `tasks`; `/bets` → `bets`;
  `/analytics` → `analytics`; `/crm` → `crm` or `billing`; `/meetings`;
  `/reports`; `/wiki`; `/llm-wiki`; `/drive`; `/events`, `/routines`,
  `/services`, `/monitoring` → `operations`), plus always-allowed routes.
  Add `hasModule(me, key)`. `canOpen` uses both. `NON_STAFF_HOME` becomes a
  function: `/` if the user has `tasks`, else the first route they can open.
- Replace every `is_staff` check that really means "can see tasks"
  (`Shell.tsx` global shortcuts + quick-add, `Sidebar.tsx` PR query,
  `MeetingDetail.tsx` linked tasks) with `hasModule(me, "tasks")`. Keep
  `is_staff` where it means staff (Drive shares, report delete, settings).
- `Sidebar.tsx`: CRM sub-items filter by module (`billing`, `licences` →
  `billing`; others → `crm`); the CRM entry shows if either is held; the
  Strategy and Operations groups show per module.
- Home (`app/page.tsx`): render `MyTasks` / `WeekOverview` / `ActivityFeed`
  only with `tasks`, `BetsOverview` only with `bets`.
- CRM page: hide tabs the user lacks; land on the first allowed tab.
- **Settings → Access** (`app/settings/access/page.tsx`, staff-only, added
  to `SETTINGS_NAV`): one table, a row per non-staff user, then two column
  groups — modules (checkboxes) and projects (checkboxes). Staff users listed
  greyed out with "Full access". Each toggle PATCHes immediately
  (optimistic, roll back on error), via a hook in `hooks/` and a key in
  `lib/query-keys.ts`. Sticky first column; horizontal scroll inside the
  table only (`min-w-0`, see the scroll invariant in CLAUDE.md). On mobile the
  same table scrolls horizontally — no separate layout.
- `npm run lint` and `npm run build` must pass.

## Docs

- Rewrite the "Access control" section of `CLAUDE.md` for the new model
  (`API_MODULES`, `TOOL_MODULES`, `user_modules`, required `module` arg).
- Update `docs/plans/crm.md` where it says CRM is staff-only, if it does.

## Out of scope (separate PRs, from the 2026-11-24 audit)

- WebSocket Origin check (cross-site WebSocket hijacking): wrap
  `core/asgi.py`'s stack in `OriginValidator` against
  `CORS_ALLOWED_ORIGINS`, not `AllowedHostsOriginValidator` (the browser's
  Origin is the frontend host, which may not be in `ALLOWED_HOSTS`).
- Wiki delete cascading into pages the deleter can't see
  (`apps/wiki/views.py` `perform_destroy`).
- Unauthenticated `/media/`.
- Per-project module lists, view-only levels, Drive / LLM wiki by project.
