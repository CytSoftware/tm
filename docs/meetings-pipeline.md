# Pushing recordings into Task Manager

For whoever maintains the recording pipeline (PLAUD → transcript → brief). The
pipeline lives outside this repo; this is the contract it pushes against.
Design background: [`plans/meetings.md`](plans/meetings.md).

## 1. Get a token

In Task Manager: **Settings → Connections → Personal access tokens → New**,
scopes **read + write**. Create it while logged in as the user the meetings
should be attributed to (a dedicated `pipeline` user is cleanest). The token is
shown once. Give it to the pipeline as an environment variable — never commit it.

```
TM_MCP_URL=https://tm-api.cytsoftware.com/mcp/
TM_MCP_TOKEN=…
```

## 2. Push a recording

One MCP tool call per recording, after the brief step:

```python
import asyncio, os
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def tm(tool: str, **arguments):
    headers = {"Authorization": f"Bearer {os.environ['TM_MCP_TOKEN']}"}
    async with streamablehttp_client(os.environ["TM_MCP_URL"], headers=headers) as (r, w, _):
        async with ClientSession(r, w) as session:
            await session.initialize()
            result = await session.call_tool(tool, arguments)
            if result.isError:
                # One readable line, e.g. "started_at: Timestamp must include…"
                raise RuntimeError(result.content[0].text)
            payload = result.structuredContent
            # A tool returning a list arrives wrapped as {"result": [...]}.
            return payload["result"] if set(payload) == {"result"} else payload

reply = asyncio.run(tm("upsert_meeting", **{
    "stem": "2026-09-16-155009-c896f4",            # the recording id — the upsert key
    "title": "Acme — pricing walkthrough",
    "started_at": "2026-09-16T15:50:09+03:00",     # MUST carry a UTC offset — see §3
    "duration_seconds": 1840,
    "language": "en",
    "speaker_count": 3,
    "category": "sales",          # client | internal | pitch_feedback | sales | interview | other
    "project": "MOW",             # TM project prefix; omit if unknown
    "summary": "One or two sentences. Shown on list rows and graph tooltips.",
    "brief_md": "## Summary\n…",  # MARKDOWN. This is what the app renders.
    "brief_html": "<html>…",      # optional; stored, never rendered
    "transcript_md": "**Ali:** …",
    "gshr_url": "https://….gshr.page",
    "people": [{"name": "Ali Khoury", "company": "Acme Logistics"}, "Chris Akoury"],
    "companies": ["Acme Logistics"],
    "mentioned_companies": ["Globex Retail"],      # came up, wasn't in the room
    "tags": ["pricing", "renewal"],
    "action_items": [{"text": "Send the SSO roadmap", "owner": "Chris"}],
    "source_meta": {"plaud_file_id": "…"},         # anything; kept verbatim
}))
print(reply["key"], reply["url"], reply["new_entities"])
```

**Read replies from `structuredContent`, not `content[0].text`** — a tool that
returns a list is split into one content block per item, so the first block is
the first row, not the list. `pip install mcp` is the only dependency. To check a deployment and a token
end to end before wiring the pipeline, run the repo's smoke test — it pushes a
throwaway meeting, re-pushes it, searches for it, and deletes it:

```
TM_MCP_URL=… TM_MCP_TOKEN=… uv run python backend/scripts/mcp_meetings_smoke.py
```

## 3. The rules

**Re-pushing is always safe.** The meeting is keyed on `stem`. Push again
whenever transcription or the brief improves:

| | On a re-push |
|---|---|
| `transcript_md`, `brief_md`, `brief_html`, `summary`, `duration_seconds`, `speaker_count`, `language`, `gshr_url`, `source_meta` | **Refreshed** from what you send |
| `title`, `category`, `project`, `started_at` | Written only if still unset — someone may have corrected them. Force with `"overwrite_metadata": true` |
| people, companies, tags | Only ever **added**; nothing is removed |
| action items | Matched by id (derived from the text if you don't send one); `done` and the linked task survive |
| any argument you omit | Left exactly as stored |

**`started_at` needs a UTC offset — from a *zone*, not a fixed offset.**
Recording stems (`2026-09-16-155009`) are the recorder's local wall-clock time
with no zone. Don't hardcode `+03:00`: Beirut is `+02:00` for half the year, so
a fixed offset puts every winter meeting an hour out. Convert through the zone
(or take it from PLAUD's metadata if present):

```python
from datetime import datetime
from zoneinfo import ZoneInfo

started_at = (
    datetime.strptime(stem[:17], "%Y-%m-%d-%H%M%S")
    .replace(tzinfo=ZoneInfo("Asia/Beirut"))
    .isoformat()
)   # "2026-09-16T15:50:09+03:00", and "+02:00" in January
```

A naive timestamp is *rejected* rather than guessed, because guessing UTC would
put every late-evening meeting on the wrong day.

**The brief must be markdown.** The app does not render HTML from the pipeline
(there is no sanitizer, by design). If the brief step only produces HTML today,
add a markdown output to that step; keep sending the HTML as `brief_html` and
the styled page as `gshr_url`, which the app links to as "Styled brief".

**Work recordings only.** `route` defaults to `"work"`; anything else is
refused. Task Manager is shared — filter personal recordings out before
pushing.

**Reuse people and company names.** People and companies are what link
meetings together, so "Ali" and "Ali Khoury" as two entities splits his
history in half. Before pushing, call `list_meeting_entities` and prefer an
existing spelling (its `aliases` also match). After pushing, check the reply's
`new_entities`: if one is a misspelling, call
`merge_meeting_entities(source="Ali", into="Ali Khoury")` — the old name
becomes an alias, so it won't come back on the next push.

Your own company counts as a company. Tagging team members with
`"company": "Cyt Software"` is fine and useful; the graph knows to group a
meeting by the *other* company in the room.

## 4. Backfill

The same call in a loop over the existing recordings. Because it is an upsert
you can run it, look at the result in `/meetings`, improve the extraction, and
run it again. Suggested order:

1. Push everything with titles, dates, transcripts and briefs.
2. Open **Meetings → Graph**. Duplicate people/companies are obvious there.
   Merge them (`merge_meeting_entities`).
3. Re-run with better category / project / people extraction. Add
   `overwrite_metadata: true` for that run only if step 1's guesses were bad
   and nobody has hand-corrected anything yet.

## 5. Other tools

Read: `list_meetings`, `search_meetings` (returns the matching snippet),
`get_meeting` (transcript only with `include_transcript=true`),
`get_related_meetings`, `list_meeting_entities`.

Write: `update_meeting` (exact, not additive — for corrections),
`delete_meeting`, `set_meeting_action_item`,
`create_task_from_meeting_action_item`, `link_meeting_task`, `link_meetings`,
`update_meeting_entity`, `merge_meeting_entities`.

A read-only token can call the read tools and is refused by the rest.
