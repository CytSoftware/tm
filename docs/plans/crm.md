# CRM — plan

Each opportunity is a **lead** on a board; what happened on it is a **thread
of updates**. People and companies are the meetings app's entities. Filled
mostly by agents (Plaud meetings, "I just called Ramzi"), by hand as the
fallback.

Status: **v2 built** on `feat/crm-leads` (2026-10-14). It replaces the v1
design (deals in configurable pipelines, touchpoints, follow-ups, contact
relationship/owner/projects) — see "Why v2" below.

## Model

| Thing | Where | Notes |
|---|---|---|
| Person / company | `meetings.Entity` | Contact fields: `position` (people), `company` (people), `phone`, `linkedin_url`, `website`, `wiki_slug`, emails (`EntityEmail`). No CRM flag. |
| Lead | `crm.Lead` | `title`, `company`, `project` (which of our businesses — Mowafeq, Cyt…), `stage`, `notes` (standing context), `lost_reason`, `closed_at`. Key `LEAD-NNN`. |
| Update | `crm.Update` | `lead` (optional), `kind` (note / message / call / email / meeting), `body` (what happened), `occurred_at`, `people` (their side), `users` (our side, default the author), `meeting` (a linked recording), `task` (what they need next). |
| Next step | `tasks.Task` via `Update.task` | Filed by the update, in the lead's project; board, `/focus`, notifications apply. |

**Stages are fixed** (`LeadStage`): New → Discovery → Demo → Pilot →
Proposal → Won · Lost. Won/Lost stamp `closed_at`; reopening clears it and
`lost_reason`. Mirror: `STAGES` in `frontend/src/lib/crm-meta.ts`.

## Decisions

- **"In the CRM" is derived.** A company is in it once it has a lead (or a
  tagged employee); a person once an update tags them or their company has a
  lead. Meetings keep auto-creating entities for everyone who speaks; those
  stay out of the lists until they're on a lead or an update. Search reaches
  everyone, so they can still be found and tagged.
- **Updates need a lead or a person.** A networking chat that isn't an
  opportunity yet still tags its people; it just has no lead.
- **Meetings are linked, not derived.** A recording shows on a lead's thread
  only when someone (or the pipeline agent) posts an update with `meeting`
  set — from the meeting page ("Post to lead…") or `post_update(meeting=…)`.
  Deriving them would flood leads with every pitch practice at QSTP.
- **What they need next is a task filed by the update that raised it**
  (`Update.task`, one-to-one, kept on the CRM side so `Task` stays CRM-free).
  It goes in the lead's project with a due date and assignee (default the
  author), so it's on the board and in `/focus`. The lead reaches it through
  the update; its next step is the soonest open one, flagged on the card when
  overdue or missing. Needs a lead with a project. (Tried and dropped on
  2026-10-14: a free `Task.lead` FK — the task wasn't tied to the update that
  created it — and a plain text field on the update — no assignee, nothing
  to tick off.)
- **Last update / next step are annotations** (`crm/query.py`), never stored.
- **Scope = TM projects.** Every list takes `project` (id/prefix/name);
  contacts are scoped through their leads.

## Surfaces

- `/crm` — Leads board (home), Activity (every update, newest first, by day),
  People, Companies. Lead pane: stage/project/company, open next
  steps, notes, composer + thread (each update shows the task it filed). Contact pane: channels, leads, people (company),
  composer + thread.
- Meeting page: "Post to lead…" posts the recording to an open lead (kind
  meeting, attendees tagged, summary as the text) and lists the leads it's on.
- REST `/api/crm/`: `leads/` (+ `move/`, `steps/`), `updates/`,
  `steps/<task key>/` (done/reopen), `contacts/`, `activity/`, `projects/`.
- MCP (12 tools, wrappers in `mcp_server/server.py`, translation in
  `crm/mcp_tools.py`): `search_leads`, `get_lead`, `upsert_lead`,
  `delete_lead`, `post_update`, `edit_update`, `delete_update`,
  `complete_next_step`, `list_crm_activity`,
  `search_contacts`, `get_contact`, `upsert_contact`.

## Why v2

v1 (2026-10-05) had 21 MCP tools across deals, touchpoints, notes and
follow-ups, plus relationship/owner/project tags on every contact. In use
(10 deals, ~9 touchpoints, 16 follow-ups after nine days):

- Deal `notes` became a running log ("27 Sep call… 13 Oct: …") because
  "post an update on the deal" wasn't a first-class action.
- Every touchpoint already had a deal — updates belong to an opportunity.
- `relationship`-based membership put 27 entities in "no next step", mostly
  noise.
- One owner on every deal; configurable pipelines used for one sales flow.

## Migration from v1

`crm/0004_leads` renames in place: deals → leads (keys stay `DEAL-NNN`; new
ones are `LEAD-NNN`), stages map by name (won/lost by kind, others → `new`),
touchpoints → updates (whatsapp → message, calendar → meeting, other →
note). `crm/0005` drops follow-ups, pipelines and stages. `meetings/0004` drops relationship, owner,
WhatsApp and project tags; headline becomes position. Dropped data: deal
owner/currency/expected close/contacts, touchpoint direction/source/external
id, the follow-up links (the tasks themselves stay in the FUP project).

## Deferred

- Gmail/Calendar ingest (v1 planned `external_id` dedup; dropped until a
  routine exists).
- Agent routines on clawdbot must move to the new tool names
  (`log_touchpoint` / `create_follow_up` → `post_update` with `next_step`,
  `create_deal`/`update_deal` → `upsert_lead`).
