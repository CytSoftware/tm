# CRM — plan

A lean, HubSpot-feeling CRM inside Task Manager: who we're talking to, where
each opportunity stands, and what we owe whom next — filled mostly by agents
(Plaud meetings, Gmail, Calendar, "I just called Ramzi"), not by hand.

Status: **phases 1–4 built** (backend, MCP tools, `/crm` UI, deals board +
stage editor) on `feat/crm`, seeded locally with the 18 recent contacts from
the export. Still to do: production seeding (5) and the Gmail/Calendar
routine + Plaud follow-up change on clawdbot (6).

## Why the last one died (and what that rules out)

The May CRM (`59f30c9`, removed in `f92acd2`) was a flat contact table with
CSV import. Chris: **it was never used, and it duplicated the wiki.** So this
one has two hard rules:

1. **It fills itself.** Every source we already have (Plaud meetings, Gmail,
   Calendar, an agent you talk to) writes into it. Manual entry is the
   fallback, not the workflow.
2. **One home per fact.** The CRM owns *state* (type, owner, channels, deals,
   follow-ups, touchpoints). The wiki owns the *story* (bio, value exchange,
   notes). Neither copies the other.

## Decisions (confirmed with Chris, 2026-10-05)

| Question | Decision |
|---|---|
| Contact / company record | **Extend `meetings.Entity`.** One table of people and companies; meetings, aliases, merge and `wiki_slug` already work. No second contact table. |
| Deals | **Light deals**, in **configurable pipelines** (seeded: Sales, Fundraising & Programs). |
| Follow-ups | **TM Tasks linked to a contact/deal**, living in a dedicated **CRM project**. "Next follow-up" is computed from open linked tasks, never typed. |
| Wiki vs CRM | **CRM = state, wiki = story.** Target is the **shared TM LLM wiki** (`/llm-wiki`), not `~/wiki`. *Chris's action, outside this repo:* drop `last_contact` / `next_followup` from the person-page schema in `~/wiki/CLAUDE.md` (and the follow-ups.md rebuild) once the CRM is live. |
| Auto-ingest | Plaud meetings, Gmail, Google Calendar, agent/MCP + a quick-log box. |
| Gmail / Calendar transport | **Agent pushes via MCP** (scheduled on clawdbot, like the Plaud pipeline). No Google OAuth in TM. |
| Home screen | **Follow-ups inbox** (Overdue / Today / This week / Later). Tabs for Deals and Contacts. |
| Users | Mostly Chris, Ali sometimes → an `owner` field + "mine" filter. No handoff/assignment UX. |
| Relationship types | `client`, `lead`, `partner`, `advisor`, `investor`, `other`, plus `internal` (Ali, Abed) — kept for meetings, hidden from the CRM. |
| v1 extras | **Contact channels** only (email, phone, WhatsApp, LinkedIn, website). |
| Seeding | Chris picks which contacts matter from the 2026-10-05 export; an agent imports **only those**, via the MCP tools below. No bulk import of all 57. |

Stated, not asked:

- **An entity is "in the CRM" iff `relationship` is set.** Meetings keep
  auto-creating entities for everyone who speaks or is mentioned; those stay
  out of CRM views until promoted. This is what stops the CRM filling with
  noise from transcripts.
- **Timeline is derived, not copied.** A meeting is already linked to its
  entities; the contact timeline unions meetings + touchpoints + completed
  follow-ups at read time. We do not write a Touchpoint row per meeting.
- **`last_contact_at` is computed** (max over meetings + touchpoints) in
  `crm/query.py`, not stored — so it can't drift. Denormalize later only if
  the contacts table gets slow.
- Auth stays flat `IsAuthenticated` (same call as meetings). Private contacts
  would be a new concept → out of scope.
- Single currency (QAR) on deal values; a `currency` field exists but the UI
  doesn't convert.

## Deferred (explicitly not v1)

- Knowledge-base surfacing: wiki excerpt on the contact, "mentioned in"
  backlinks, auto-stub wiki pages, CRM chips inside wiki pages. v1 keeps only
  the existing `wiki_slug` as a plain "Open in wiki" link.
- Referral tracking (`introduced_by`, referral tree).
- Going-cold nudges (cadence per relationship type). v1 has only the cheap
  version: a "no next step" filter (in-CRM contact with no open follow-up).
- Relationship graph (reuse of `MeetingsGraph`).
- Native Google OAuth sync, storing email bodies.
- Email sequences, sending mail from TM, lead scoring, forecasting.

## 1. Data model

### `meetings.Entity` — new fields (migration in `meetings`)

| Field | Notes |
|---|---|
| `relationship` | choices above, `blank` = not in CRM. Indexed. |
| `owner` | FK user, `SET_NULL`, null. |
| `headline` | Short line — "Regional Director of BIM, ECG". Not a bio; the bio is the wiki's. |
| `phone`, `whatsapp`, `linkedin_url`, `website` | Plain fields. UI renders `tel:`, `https://wa.me/…`, `mailto:`. |

**`EntityEmail`** (in `meetings`) — `entity` FK (CASCADE,
`related_name="emails"`), `email` (lowercased, **unique**). A table, not a
JSON list on Entity: `find_contacts_by_email` is the Gmail/Calendar ingest hot
path and needs an indexed batch `email__in` lookup, and Django's JSON
containment lookups don't exist on SQLite (the reason meetings chose a `Tag`
table too; `resolve_entity`'s Python-side alias scan is fine for names, not
for batch email matching). Unique also stops one address landing on two
people.

`merge_entities` must be extended to fold the new fields (move `emails`,
keep target's scalars unless empty) and repoint deals, touchpoints and
follow-ups. Any new Entity field needs a line in that merge — note it in the
model docstring.

### New app `apps/crm/`

The stale `backend/apps/crm/` (only `__pycache__` + old migrations dir) is
deleted first; old tables were already dropped by `tasks` 0022.

**`Pipeline`** — `name`, `slug` (unique), `position`. Seeded by data
migration: *Sales*, *Fundraising & Programs*.

**`Stage`** — FK `pipeline` (CASCADE), `name`, `position`, `kind`
(`open` / `won` / `lost`; mirrors `Column.kind`). Seeds:
- Sales: Discovery → Demo → Pilot → Proposal → Won · Lost
- Fundraising & Programs: Identified → Applied → In process → Accepted · Rejected

**`Deal(TimestampedModel)`**

| Field | Notes |
|---|---|
| `key` | `DEAL-001`, generated like `MTG-001` (counter singleton, `select_for_update`). DRF lookup. |
| `title` | "ECG — Mowafeq pilot". |
| `pipeline`, `stage` | FK; `stage.pipeline` must equal `pipeline` (serializer + MCP validation, like `Task.bet`). |
| `company` | FK Entity (`kind=company`), `SET_NULL`, null — same as `Task.bet`; deleting a company shouldn't delete its deal history. |
| `contacts` | M2M Entity (people). |
| `owner` | FK user, null. |
| `value`, `currency` | Decimal null, `QAR`. |
| `product_project` | FK `tasks.Project` null — which product it's for (Mowafeq, Services…). |
| `expected_close` | date null. |
| `position` | float, midpoint insertion within a stage (same as `Task.position`). |
| `closed_at`, `lost_reason` | Set when moved into a won/lost stage; cleared when moved back. |

**`Touchpoint(TimestampedModel)`** — an interaction that isn't a recorded
meeting.

| Field | Notes |
|---|---|
| `kind` | `email`, `call`, `whatsapp`, `calendar`, `note`, `other`. |
| `direction` | `in` / `out` / blank. |
| `occurred_at` | tz-aware required (same rule as `Meeting.started_at`). |
| `summary` | One or two lines. **Never full email bodies.** |
| `entities` | M2M Entity (an email thread can involve several people). |
| `deal` | FK null. |
| `source` | `gmail`, `calendar`, `agent`, `manual`. |
| `external_id` | blank or unique per `source` (Gmail message/thread id, Calendar event id) → **idempotent agent pushes**, same contract as `Meeting.stem`. |
| `created_by` | FK user. |

**`FollowUp`** — the link that makes a Task a CRM follow-up. `task`
OneToOne (CASCADE, `related_name="crm_follow_up"`), `entity` FK (CASCADE),
`deal` FK null. Keeps `tasks.Task` untouched (no cross-app FK on the core
model), copied from the `MeetingTask` / `TaskPullRequest` join pattern.

**CRM project.** Created **at runtime, not in a migration**: the default
columns are seeded by a `post_save` receiver on the real `Project` class
(`tasks/models.py`), which doesn't fire for historical models inside a data
migration — a migration-made project would have no columns to put tasks in.
So `services.crm_project()` `get_or_create`s it ("CRM", prefix `FUP`) on first
use and stores its id in a tiny `CrmSettings` singleton (renaming the project
doesn't break it). `create_follow_up` always targets it; its normal columns,
notifications, `/focus` and MCP all apply.

**It is a normal project, so FUP tasks also appear** on the all-projects
board, `/focus`, throughput and weekly completions. That's intended — the
point of follow-ups-as-tasks is that they sit next to the rest of the day's
work. If it gets noisy, archive-style exclusion via the existing
`include_archived` path is the fix, not a special case.

## 2. Backend logic (`apps/crm/`)

Same file layout as meetings: `models.py`, `id_generation.py`, `query.py`,
`services.py`, `timeline.py`, `serializers.py`, `views.py`, `urls.py`,
`broadcast.py`, `admin.py`, `mcp_tools.py`, `test_*.py`.

- **`query.py`** — single filter/sort path for contacts and deals (the
  `tasks/query.py` contract). Contacts annotate `last_contact_at` (Subquery
  max over `MeetingEntity→Meeting.started_at` and `Touchpoint.occurred_at`)
  and `next_follow_up_at` (min `due_at` of open FollowUp tasks). Filters:
  `relationship`, `owner`, `kind`, `company`, `search` (`icontains` over
  name/aliases/emails/headline), `no_next_step`, `overdue`. No SQLite-only SQL.
- **`timeline.py`** — `entity_timeline(entity)` merges meetings, touchpoints
  and completed/open follow-ups into one sorted list of
  `{type, at, title, ref}`. For a company it includes its people's items.
- **`services.py`** — `promote_entity` (set relationship/owner),
  `log_touchpoint` (resolve entities by id / name / **email**, upsert on
  `(source, external_id)`, optional `follow_up`), `create_follow_up`,
  `move_deal` (stage + position + closed_at), pipeline/stage CRUD with
  "can't delete a stage that has deals".
- **Inbox endpoint** — `GET /api/crm/inbox/?tz=Asia/Qatar` returns open
  follow-ups bucketed Overdue / Today / This week / Later. TM stores no
  per-user timezone, so the browser sends its IANA zone (default
  `Asia/Qatar`); MCP `list_follow_ups` takes the same optional `tz`. Plus the
  "no next step" list, with `?owner=me`.
- **Broadcasts** — a global `crm` Channels group (`ws/crm/`, `scope: "crm"`
  on the internal bridge) for deal/touchpoint/entity writes. Follow-up tasks
  already broadcast as tasks; the CRM page also listens on the CRM project's
  group. Every write path calls it; fire-and-forget.
- **Meeting action items** — `create_task_from_action_item` gains an optional
  `entity` → creates the task in the CRM project with a FollowUp row. (Action
  items about engineering work keep going to their project as today.)

## 3. MCP tools (`apps/crm/mcp_tools.py`, wrappers in `server.py`)

Thin translation only, like `meetings/mcp_tools.py`. Reads go in
`READ_ONLY_TOOLS`.

| Tool | R/W | Purpose |
|---|---|---|
| `search_contacts` | R | Filtered list (relationship, owner, no_next_step, overdue, search). |
| `get_contact` | R | Entity + channels + deals + open follow-ups + timeline (capped). |
| `find_contacts_by_email` | R | Batch match `emails=[…]` → entities. What the Gmail/Calendar agent calls first. |
| `update_contact` | W | relationship, owner, headline, channels, emails (add/remove), company, wiki_slug. Promotes a meeting entity into the CRM. |
| `log_touchpoint` | W | Kind, occurred_at, summary, people by name/email, optional deal, `source` + `external_id` (idempotent), optional `follow_up={title, due_at, assignee}`. |
| `create_follow_up` | W | Task in the CRM project linked to entity (+deal). |
| `list_follow_ups` | R | The inbox buckets. |
| `list_pipelines` | R | Pipelines + stages. |
| `search_deals` / `get_deal` | R | |
| `create_deal` / `update_deal` / `delete_deal` | W | Moving = `update_deal(stage=…)`. |
| `add_contact_note` | W | A `note` touchpoint — keeps a contact's context current. |
| `update_touchpoint` / `delete_touchpoint` | W | Correct or remove a logged touch/note. |
| `list_crm_activity` | R | Cross-contact feed (meetings, touches, closed follow-ups) for the last N days. |
| `create_pipeline` / `update_pipeline` / `delete_pipeline` | W | Stages by name keep their id (and deals). |

Existing `list_meeting_entities` / `merge_meeting_entities` stay the dedup
tools. Server instructions get a short CRM section: reuse existing spelling,
never log email bodies, always pass `external_id` for Gmail/Calendar.

## 4. UI — `/crm`

Sidebar entry "CRM" in the Workspace group (after To Review). All view state in the URL
(`tab`, filters, open `c=<entity>` / `d=<deal>`), like meetings.

- **Inbox (default tab).** Overdue / Today / This week / Later, one row per
  follow-up: contact, company, task title, due, owner. Row actions: done,
  snooze (+1d / +1w / pick), log touch, open contact. "No next step" section
  at the bottom (in-CRM contacts with no open follow-up) with a one-click
  "add follow-up". `Mine / All` toggle.
- **Contacts.** Table (People | Companies) with relationship, company, owner,
  last contact, next follow-up; filter bar; `MasterDetail` to the detail pane.
- **Contact detail.** Header: name, relationship pill, company, owner,
  headline, channel buttons (call / WhatsApp / email / LinkedIn), "Open in
  wiki" if `wiki_slug`. Sections: Follow-ups (open), Deals, Timeline
  (meetings link to `/meetings?m=…`), People (companies only). Quick-log box:
  kind · note · optional follow-up date → `log_touchpoint`.
- **Activity.** Cross-contact history for the last 7/14/30/90 days, grouped
  by day; notes edit inline.
- **Deals.** Pipeline switcher + kanban by stage, value total per column.
  Desktop drag via `@atlaskit/pragmatic-drag-and-drop` under
  `(pointer: fine)`; touch gets the long-press → `MoveTaskSheet`-style sheet
  (per the responsive conventions). Deal detail in a sheet.
- **Settings → CRM.** Pipeline + stage editor (rename, reorder, add, set
  won/lost) — reuse the one-Save column editor pattern from TAS-069.
- **Promote from meetings.** In `MeetingDetail`, each person/company chip
  gets "Add to CRM" (sets relationship) — the main way meeting entities enter
  the CRM by hand.

## 5. Ingest agents (outside this repo, documented in `docs/crm-ingest.md`)

- **Plaud** — already pushes meetings. Change: after `upsert_meeting`, for
  attendees with a relationship set, action items owned by us become
  `create_follow_up` calls instead of plain tasks.
- **Gmail + Calendar** — scheduled routine on clawdbot (daily, or a few
  times a day). For each message/event since the last cursor: collect
  participant addresses → `find_contacts_by_email` → for matches only,
  `log_touchpoint(source=gmail|calendar, external_id=…, summary=subject + 1-line gist)`.
  Unknown senders are ignored (no auto-creating contacts from email — that's
  how the CRM fills with noise). Calendar events that also produced a Plaud
  recording are skipped by time overlap.
- **Conversational** — "called Ramzi, he'll send the drawings Thursday" →
  agent calls `log_touchpoint(..., follow_up={title: "Get drawings from Ramzi", due_at: Thu})`.

## 6. Seeding

1. Chris marks which of the 57 export contacts are relevant.
2. An agent, using only the MCP tools: resolves each to an existing Entity
   (or creates it), merges duplicates (Shelter / Shelter Group; Al Madar's
   Sofia & Marwa are two people, one company), sets relationship / company /
   owner / channels / `wiki_slug`, creates open deals for live opportunities
   (ECG pilot, Al Hattab, Shelter, Sharq…), and turns genuine open reminders
   into follow-ups.
3. The bulk-stamped `01 Oct 2026` dates are **not** carried over as-is — the
   agent lists them for Chris to re-date or drop.
4. Historical wiki interaction-log entries are not re-imported as touchpoints
   (they stay in the wiki — the story side); only meetings already in TM show
   on the timeline.
5. Afterwards, CRM follow-ups stop going into Apple Reminders.

## Phases

| # | Scope | Ships |
|---|---|---|
| 1 | Entity fields + merge, `apps/crm` models, seeds, query/services/timeline, REST, broadcasts, tests | Backend usable via API |
| 2 | MCP tools + server instructions + tests | Agents can read/write; seeding possible |
| 3 | `/crm` Inbox + Contacts + detail + quick-log + "Add to CRM" in meetings | Daily use starts |
| 4 | Deals board + pipeline settings | Pipeline view |
| 5 | Seed from Chris's list | Real data |
| 6 | Gmail/Calendar routine + Plaud change (clawdbot) + `docs/crm-ingest.md` | Self-filling |

## Open questions

- Is the unnamed "Real-Estate Developer (AI automation prospect)" Shelter?
  If so, `merge_meeting_entities` folds it in.
- Ali's leads (France / Artelia / CETEC) — owner Ali from day one?
- Settled: follow-up prefix is `FUP`; seed = the 18 contacts active since
  2026-09-01.
