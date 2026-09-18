# Meetings — plan

A home in Task Manager for recorded meetings (customer, internal, anything
work-related): transcript + summary + brief + action items, pushed in by the
PLAUD pipeline over MCP, and explorable by time, by who/what was involved, and
as a graph of how meetings connect.

Status: **backend core (phase 1) merged; UI (phases 4–5) built** on `feat/tas-070-meetings-ui`. Still to do: MCP tools (2), backfill (3), entity-merge UI (6). Tracked as **TAS-070**; branch
`feat/tas-070-meetings`.

## Decisions (confirmed with Chris, 2026-09-18)

| Question | Decision |
|---|---|
| How the brief is rendered | **Markdown.** The pipeline pushes `brief_md`; TM renders it with the existing `markdown-it` (`html: false`) path. `brief_html` is stored but never rendered; the `gshr.page` link opens the styled artifact. |
| People / companies | **Light `Entity` table**, M2M to meetings, auto-created on ingest, optionally pointing at the LLM-wiki page. Not tags, not the old CRM. |
| Link exploration | **Interactive graph ships in v1**, alongside list + timeline. |
| Storage | **All text in SQLite, no audio.** Audio stays on clawdbot. |

Stated, not asked:

- **Only `route=work` is pushed.** TM is shared (Ali, Abed); personal
  recordings must be filtered out pipeline-side. The `route` field stays so the
  server can also reject `personal` defensively.
- Auth is flat `IsAuthenticated` in this codebase — every TM user sees every
  meeting. If some customer meetings must be restricted, that is a new concept
  (no per-project membership exists) and is **out of scope** here.
- The dead `backend/apps/crm/` and `pipelines/` `__pycache__` dirs are left
  alone.

## 1. Backend — `backend/apps/meetings/`

New app, added to `INSTALLED_APPS`. Files: `models.py`, `id_generation.py`,
`query.py`, `related.py`, `serializers.py`, `views.py`, `urls.py`,
`broadcast.py`, `admin.py`, `tests.py` + `test_<topic>.py`.

### Models

**`Meeting(TimestampedModel)`**

| Field | Notes |
|---|---|
| `key` | `MTG-001`, `unique`, DRF lookup field. Generated in `save()` on first insert via a `MeetingCounter` singleton row — copy `apps/wiki/id_generation.py` exactly (`select_for_update` inside `transaction.atomic`; the counter row is `get_or_create`d on first use, so no seed migration). |
| `stem` | `unique`, e.g. `2026-09-16-155009-c896f4`. **The pipeline's natural key** — ingest upserts on it, so re-runs are idempotent. |
| `title` | From the brief. |
| `started_at` | `DateTimeField`, indexed. A datetime, not a date — two meetings a day must order correctly. PLAUD stems (`2026-09-16-155009`) are naive local time: the pipeline must send a tz-aware ISO timestamp (tz from PLAUD metadata if present, else a pipeline constant), and ingest rejects naive values — otherwise every timeline day boundary is off. |
| `duration_seconds`, `language`, `speaker_count` | Plain metadata; `language` free text (`en`, `ar`, `mixed`). |
| `route` | choices `work` / `personal`, default `work`. Ingest rejects `personal`. |
| `category` | choices: `client`, `internal`, `pitch_feedback`, `sales`, `interview`, `other`. Choices, not free text, so grouping doesn't fragment; extend the enum as needed. |
| `summary` | Short plain-text/markdown abstract — what list cards and graph tooltips show. |
| `brief_md` | The rendered brief. |
| `brief_html` | Stored for fidelity/export only. **Never rendered.** |
| `transcript_md` | Full clean transcript. |
| `gshr_url` | `URLField`, blank. |
| `action_items` | JSON `[{id, text, owner, done, task_key}]` — see §1 "Action items". |
| `project` | FK → `tasks.Project`, `SET_NULL` (same choice as `Task.bet`), `related_name="meetings"`. |
| `entities` | M2M → `Entity` through `MeetingEntity`. |
| `tags` | M2M → a tiny `Tag(name)` model, lowercase. Not `tasks.Label` (it does support global labels, but reusing it would pour meeting topics into the board's label pickers), and not a JSON list: filtering a JSON array needs containment lookups SQLite doesn't have, and the text-match workaround breaks on non-ASCII (Arabic) tags. Tags are additive on a re-push, exact on a UI edit. |
| `source_meta` | JSON — raw PLAUD metadata, kept verbatim so nothing is lost. |
| `created_by` | FK → user, `SET_NULL`. From `_get_mcp_user()` / `request.user`. |

**`Entity(TimestampedModel)`** — `kind` (`person` / `company`), `name`,
`slug` (unique per kind), `aliases` (JSON list), `wiki_slug` (blank; e.g.
`entities/people/ali-k` — the detail page links to `/llm-wiki#w/<slug>`),
`company` (self-FK, null, `SET_NULL` — a person's employer, which gives the
graph person→company edges for free).

Resolution on ingest (`resolve_entity(kind, name)`): slugify → match `slug`,
then any `aliases` entry → else create. An `update_entity` MCP tool + a merge
admin action fix the inevitable "Ali" vs "Ali K." split: merging repoints
`MeetingEntity` rows and appends the losing name to `aliases`, so the pipeline
keeps resolving to the survivor.

**`MeetingEntity`** — through model, `role` (`attendee` / `mentioned`), unique
on `(meeting, entity)`. Attendee vs mentioned matters: "meetings Ali was in"
and "meetings where Acme came up" are different questions.

**`MeetingTask`** — join model copied from `TaskPullRequest`
(`integrations/models.py:105`): FK `meeting`, FK `task`
(`related_name="meeting_links"`, `CASCADE`), unique together. No generic
relations — the codebase has none.

**`MeetingLink`** — explicit edge: `from_meeting`, `to_meeting`, `kind`
(`follow_up` / `related`), `note`, unique on the pair. For the links shared
metadata can't infer ("this was the follow-up to that call").

### Upsert must not clobber curation

The pipeline re-pushes meetings as extraction improves; people also edit
category, project, tags and entities in the UI and merge duplicate entities.
Without a rule, the first re-run after backfill silently undoes that work. So
`upsert_meeting` splits fields by owner:

- **Pipeline-owned — always overwritten:** `transcript_md`, `brief_md`,
  `brief_html`, `summary`, `duration_seconds`, `speaker_count`, `language`,
  `source_meta`, `gshr_url`.
- **Curated — written on create only**, unless the call passes
  `overwrite_metadata=true`: `title`, `category`, `project`, `tags`,
  `started_at`.
- **Entity links are additive.** A re-upsert adds newly found entities and
  never removes existing `MeetingEntity` rows. Names resolve through `aliases`,
  so a merged entity is not recreated.
- **Action items merge by `id`:** text refreshes, but `done` and `task_key`
  survive. The pipeline must therefore emit stable ids (hash of the normalised
  text is enough).

### Action items

Stored as JSON on the meeting, each with a stable `id`. Two actions on the
detail page / over MCP: toggle `done`, and **"Create task"** — creates a real
`Task` in the meeting's project (through the normal task write path, so
`record_transition`, `broadcast_task_event` and `notify_task_event` all fire),
writes `task_key` back onto the item and adds a `MeetingTask` row. Tasks are
not auto-created on ingest: LLM-extracted items are too noisy to dump on the
board unreviewed.

### Filtering and search — `meetings/query.py`

Same contract as `tasks/query.py`: `base_meeting_queryset()` (with
`select_related("project")`, `prefetch_related` entities),
`apply_meeting_filters(qs, filters)`, single source of truth for both DRF and
MCP. Filter keys: `project`, `category`, `entity` (slug or id), `company`,
`person`, `tag`, `date_from`, `date_to`, `search`. Unknown keys ignored.

`search` = `Q(icontains)` across `title`, `summary`, `brief_md`,
`transcript_md`, plus entity names. At 29 meetings (and at 2,900) this is fine
on SQLite and carries over to Postgres unchanged. **No FTS5** — it would be
the first SQLite-only SQL in the repo and CLAUDE.md forbids baking that in.
When the Postgres swap happens, this one function becomes `SearchVector`.

Search results return a **snippet**: the matching transcript line ± ~120
chars, computed in Python for the (paginated) result page — so the UI can show
*why* a meeting matched.

### Related meetings and the graph — `meetings/related.py`

Links are **derived**, not stored, apart from `MeetingLink`:

- `related_meetings(meeting)` → scored list. Shared attendee ×3, shared
  company ×3, shared mentioned entity ×1, same project ×2, shared tag ×1,
  explicit `MeetingLink` = pinned to the top. Returns the reasons with each hit
  ("Ali K., Acme") so the panel can show them.
- `build_graph(filters)` → `{nodes, edges}`. Nodes: meetings, people,
  companies, projects. Edges: meeting–entity (weight by role), meeting–project,
  person–company, meeting–meeting (`MeetingLink` only). Deliberately **no
  derived meeting–meeting edges** in the graph: two meetings sharing a person
  are already connected *through* that person's node, and adding the direct
  edge turns the picture into a hairball. Takes the same filter dict as the
  list, so the graph can be scoped to a company, project or date range.

### REST API — `/api/meetings/`

`MeetingViewSet` (`lookup_field="key"`): list (light serializer — no
transcript/brief bodies), retrieve (full), create/update/delete, plus
`GET /api/meetings/graph/`, `GET /api/meetings/<key>/related/`,
`POST /api/meetings/<key>/action-items/<id>/create-task/`.
`EntityViewSet`: list (with `meeting_count`), retrieve (with its meetings),
update, `POST merge/`.

Django's 2.5 MB `DATA_UPLOAD_MAX_MEMORY_SIZE` applies to these REST endpoints.
A long transcript is ~100–200 KB so it's fine, but raise it to 10 MB in
`settings.py` to match the MCP guard rather than find out later.

### Realtime — `meetings/broadcast.py`

Mirror `apps/wiki/broadcast.py`: one global `meetings` group, message type
`meeting.event` (→ consumer method `meeting_event`), events
`meeting.created|updated|deleted`, `entity.updated`. A `MeetingsConsumer` at
`ws/meetings/`. For the stdio MCP process, add a `scope: "meetings"` branch to
`internal_broadcast` (`tasks/views.py:597`). Fire-and-forget, must not throw.

## 2. MCP tools (`mcp_server/server.py` + `tools.py`)

| Tool | R/W | Notes |
|---|---|---|
| `upsert_meeting` | W | Keyed on `stem`. Creates or updates under the field-ownership rule in §1 (`overwrite_metadata: bool = False`); `people` / `companies` are name lists resolved via `resolve_entity`; `project` accepts a prefix. Returns `{key, created: bool, url}`. Named *upsert*, not `create_meeting`, so the pipeline author knows re-pushing is safe. |
| `update_meeting` | W | Partial update by `key` or `stem`. |
| `delete_meeting` | W | |
| `link_meeting_task` / `unlink_meeting_task` | W | |
| `link_meetings` | W | Creates a `MeetingLink`. |
| `update_entity` / `merge_entities` | W | |
| `list_meetings` | R | Filters from `query.py`; light payload. |
| `get_meeting` | R | By `key` or `stem`; `include_transcript: bool = True`. |
| `search_meetings` | R | `query` + filters; returns snippets. |
| `get_related_meetings` | R | |
| `list_entities` | R | So the pipeline can check existing names before pushing. |

All five reads go into `READ_ONLY_TOOLS`. Every write takes the caller from
`_get_mcp_user()` (never the ContextVar) and ends with a `broadcast` call.
Transcripts are far below the 10 MB stdio guard. Update the server
`instructions` string in `server.py` with a short MEETINGS section (upsert by
stem, work-only, check `list_entities` first).

## 3. Frontend — `/meetings`

New files: `app/meetings/page.tsx`, `components/meetings/*`,
`hooks/use-meetings.ts`, `lib/meetings-ws.ts` (copy of `lib/wiki-ws.ts`),
keys in `lib/query-keys.ts`, types in `lib/types.ts`, a Sidebar `NavLink`
beside LLM Wiki (`Sidebar.tsx:391`).

**Page shell** — header with search box + filter chips (category, company,
person, project, date range) + a view switcher. Filters and the view live in
the URL (`?view=graph&company=acme`) so a filtered view is linkable. Three
views over the *same* filtered set:

1. **List** — grouped, with a "group by" control: month (default), company,
   person, category, project. Rows: title, date, duration, category chip,
   entity avatars/chips, summary line; search mode shows the snippet.
2. **Timeline** — hand-rolled (no calendar lib exists, none needed): a
   vertical month-by-month rail with meetings as cards on their day, plus a
   compact year heat-strip on top for jumping (pattern: `TrendStrip.tsx`,
   `bets/PeriodMasthead.tsx`).
3. **Graph** — see below.

**Addressing a meeting** — `/meetings?m=MTG-001`. A query param rather than a
`/meetings/[key]` segment, so the list page owns selection and the current
view + filters survive opening a meeting (`?view=graph&company=acme&m=MTG-014`
is a shareable link to a meeting *in context*). This is the `url` that
`upsert_meeting` returns, built from `FRONTEND_URL`.

**Detail** — `MasterDetail` (as `/llm-wiki` does) so selecting a meeting from
any view opens it in the right pane on desktop and full-screen on mobile.
Header: title, date, duration, category, project, entity chips, "Open styled
brief ↗" (`gshr_url`). Tabs: **Brief** (markdown) · **Transcript** (markdown,
in-page find, speaker names emphasised) · **Action items** (toggle done,
"Create task" → shows the task key chip afterwards) · **Linked tasks**. A side
panel lists **Related meetings** with the reason for each.

**Entity view** — clicking a person/company chip anywhere filters the page to
that entity and shows a small header (name, company, wiki link, meeting
count). No separate route; it is the list with a filter, which keeps all three
views working for "everything with Acme".

**Markdown** — reuse the `markdown-it` config *and the `validateLink` guard*
from `llm-wiki/page.tsx:28-45`; hoist both into `lib/markdown.ts` rather than
making a third copy. `html: false` stays.

### The graph

**As built:** SVG rendered by React over a `d3-force` layout (the only new
dependency), not `react-force-graph-2d` as first planned. At tens to a few
hundred nodes SVG costs nothing and buys theme tokens that work in dark mode
for free, crisp text, and focusable nodes for the keyboard. The simulation is
ticked synchronously to completion instead of animated: the picture doesn't
drift under the cursor, the same data lands in the same place every visit, and
it doesn't depend on `requestAnimationFrame` (frozen in background tabs).
Pan / wheel-zoom / pinch / node-drag are ~80 lines of pointer events.

"Group by" (company · project · category · month · none) is a layout concern:
each group gets an anchor on a ring, an x/y force pulls members in, and the
enclosing circle is measured afterwards. Grouping by company picks the *rarest*
company in the room — your own company attends everything and would otherwise
swallow every meeting. Links that leave a cluster are drawn faint. Selecting a
meeting lights its people/companies and, one step quieter, the other meetings
they're in — its linked meetings.

- Node types are visually distinct: meetings (small, coloured by category),
  people, companies (larger), projects. Colours from `lib/chart-colors.ts`,
  re-read on theme change since canvas doesn't inherit CSS variables.
- Hover → highlight the node's neighbourhood, dim the rest. Click a meeting →
  opens the detail pane. Click an entity → re-centre and filter to it.
- Same filter chips as the list; plus toggles for "show mentioned" (off by
  default — attendee edges only keeps it readable) and "show projects".
- Touch: pan/zoom/tap work on canvas natively, so unlike the drag-and-drop
  surfaces this needs no long-press fallback. Node tap targets get a minimum
  hit radius.
- Layout invariant: the canvas needs explicit pixel dimensions — size it from
  a `ResizeObserver` on a `min-h-0 min-w-0 flex-1` wrapper, never from
  `window`, or it will push the page past `innerHeight`.

Responsive rules from CLAUDE.md apply throughout: `max-lg:` variants,
`tap-target` on small controls, `hover-none:` counterparts for hover-revealed
actions, `shrink-0` on the horizontally scrolling filter bar.

## 4. Pipeline integration + backfill

Both live on **clawdbot**, not in this repo, and can't be run or verified from
here — the repo side just has to make them easy.

- **Going forward**: after the brief step, the pipeline calls `upsert_meeting`
  over the remote MCP endpoint (`/mcp/`) with a personal access token
  (`McpAccessToken`, `write` scope). Needs the pipeline to emit the brief as
  markdown alongside the HTML — **check whether the pre-HTML markdown still
  exists** in the pipeline; if the HTML is generated directly, add a markdown
  output to that step.
- **Backfill (~29 recordings)**: a pipeline-side script looping over
  `plaud-transcripts/work/*.md`, building the same payload, calling
  `upsert_meeting`. Idempotent by `stem`, so it can be re-run as extraction
  improves. Category / people / companies come from an LLM pass over each
  brief; review the resulting entity list once and merge duplicates.
- **Fallback in-repo**: `manage.py import_meetings --dir <path>` reading the
  pipeline's output layout (`<stem>.md`, `<stem>.brief.html`, results JSON for
  duration/speakers). Useful for local dev fixtures too.

## 5. Build order

Each phase is a mergeable PR.

1. **Backend core** — app, models, migrations, counter seed, `query.py`,
   serializers, viewsets, admin, broadcast + consumer + `internal_broadcast`
   branch, tests.
2. **MCP** — tools, `READ_ONLY_TOOLS`, server instructions, tests in
   `apps/mcp_server/tests.py` (read-only token can read but not upsert;
   upsert is idempotent on `stem`; `personal` is rejected; attribution comes
   from the ASGI scope).
3. **Backfill** — now, before the UI, so every view is built against the real
   29 meetings instead of fixtures.
4. **Frontend list + detail** — page shell, filters, list grouping, detail
   tabs, action-item → task, related panel, websocket.
5. **Timeline + graph** — `related.py` `build_graph`, the graph endpoint, the
   two remaining views.
6. **Polish** — entity merge UI, mobile pass (scroll invariant at every
   width), docs: a Meetings section in `CLAUDE.md` **and** `AGENTS.md` (the Codex
   mirror of the same file — keep them in step).

## 6. Tests

`apps/meetings/tests.py` + `test_query.py`, `test_related.py`,
`test_entities.py`: key generation, upsert idempotency, entity
resolve/alias/merge, every filter key, search snippets, related scoring,
graph shape, action-item → task (incl. the broadcasts firing), `SET_NULL` on
project delete. MCP coverage as listed in phase 2. Frontend: `npm run lint` +
`npm run build`, then a browser pass on the scroll invariant.

## Confirmed (2026-09-18)

- Categories: `client`, `internal`, `pitch_feedback`, `sales`, `interview`,
  `other`.
- Meetings are visible to every TM user; work recordings only.
- Pipeline side: the brief must reach TM as markdown. If the brief step only
  produces HTML today, add a markdown output there — first item of the
  pipeline work in §4.
