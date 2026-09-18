"""End-to-end smoke test for the meeting MCP tools, over the real transport.

    TM_MCP_URL=https://tm-api.cytsoftware.com/mcp/ \\
    TM_MCP_TOKEN=<personal access token, read+write> \\
    uv run python backend/scripts/mcp_meetings_smoke.py

Run it against a deployment to confirm the tools are live and a token works
*before* pointing the recording pipeline at it. It pushes one throwaway meeting
(stem ``smoke-test-…``), re-pushes it, reads it back, searches for it, and
deletes it again — so it is safe to run against production. People and
companies are deliberately not sent, so it leaves no entities behind.

Exits non-zero on the first thing that isn't as expected.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

EXPECTED_TOOLS = {
    "upsert_meeting", "update_meeting", "delete_meeting", "list_meetings",
    "search_meetings", "get_meeting", "get_related_meetings",
    "list_meeting_entities", "set_meeting_action_item",
    "create_task_from_meeting_action_item", "link_meeting_task",
    "link_meetings", "update_meeting_entity", "merge_meeting_entities",
}  # fmt: skip


def check(ok: bool, label: str, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")
    if not ok:
        sys.exit(1)


async def call(session: ClientSession, tool: str, **arguments):
    """Call a tool; return ``(is_error, payload)``.

    Read the payload from ``structuredContent``, not ``content[0].text``: a
    tool that returns a *list* is split into one content block per item, so
    the first block is the first row rather than the whole list. Tools
    returning a list arrive wrapped as ``{"result": [...]}``.
    """
    result = await session.call_tool(tool, arguments)
    if result.isError:
        return True, result.content[0].text if result.content else ""
    payload = result.structuredContent
    if isinstance(payload, dict) and set(payload) == {"result"}:
        return False, payload["result"]
    return False, payload


async def main() -> None:
    url, token = os.environ.get("TM_MCP_URL"), os.environ.get("TM_MCP_TOKEN")
    if not url or not token:
        sys.exit("Set TM_MCP_URL and TM_MCP_TOKEN.")
    stem = f"smoke-test-{uuid.uuid4().hex[:10]}"
    marker = f"smokemarker{uuid.uuid4().hex[:8]}"
    headers = {"Authorization": f"Bearer {token}"}

    async with streamablehttp_client(url, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = {t.name for t in (await session.list_tools()).tools}
            check(EXPECTED_TOOLS <= tools, "meeting tools are registered",
                  sorted(EXPECTED_TOOLS - tools) or f"{len(EXPECTED_TOOLS)} found")

            err, _ = await call(session, "upsert_meeting", stem=stem, title="x",
                                started_at="2026-01-01T10:00:00")
            check(err, "a timestamp without a UTC offset is refused")

            err, made = await call(
                session, "upsert_meeting", stem=stem,
                title="MCP smoke test (safe to delete)",
                started_at=datetime.now(timezone.utc).isoformat(),
                category="internal", summary="Automated smoke test.",
                brief_md="## Smoke test\nPushed by mcp_meetings_smoke.py.",
                transcript_md=f"**Tester:** the marker is {marker}.",
                action_items=["Delete this meeting"],
            )
            check(not err and made["created"], "push creates a meeting", made if err else made["key"])
            key = made["key"]
            try:
                err, again = await call(session, "upsert_meeting", stem=stem,
                                        title="Should not replace the title",
                                        transcript_md=f"**Tester:** v2, marker {marker}.")
                check(not err and not again["created"] and again["key"] == key,
                      "re-push updates the same meeting")
                check(again["title"].startswith("MCP smoke test"),
                      "re-push keeps the existing title")

                err, hits = await call(session, "search_meetings", query=marker)
                check(not err and [h["key"] for h in hits] == [key],
                      "search finds it by transcript text", hits if err else hits[0]["snippet"])

                err, got = await call(session, "get_meeting", meeting=stem, include_transcript=True)
                check(not err and "v2" in got["transcript_md"] and len(got["action_items"]) == 1,
                      "get by stem returns the refreshed transcript")
                print(f"      {got['url']}")
            finally:
                err, gone = await call(session, "delete_meeting", meeting=key)
                check(not err, "cleanup: meeting deleted", gone if err else "")
    print("All good.")


if __name__ == "__main__":
    asyncio.run(main())
