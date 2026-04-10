"""Management command: run the MCP server over stdio (for local Claude Desktop).

Two ways to expose MCP:

1. **Remote (recommended for production / Dokploy)**:
   MCP is automatically available at ``/mcp/`` when running daphne.
   No extra process needed. Agents connect via HTTP with a Bearer token:

       MCP URL:   https://your-domain.com/mcp/
       Auth:      Authorization: Bearer <CYT_MCP_TOKEN>

   Set ``CYT_MCP_TOKEN`` in the environment to secure the endpoint.

2. **Local stdio (for Claude Desktop)**:
   Run this command: ``python manage.py mcp_serve``

   Claude Desktop config:

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
"""

from __future__ import annotations

import asyncio
import os

from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Run the MCP server over stdio (for Claude Desktop). For remote HTTP access, MCP is served at /mcp/ by daphne automatically."

    def handle(self, *args, **options):
        os.environ.setdefault(
            "CYT_BROADCAST_URL",
            "http://127.0.0.1:8000/api/internal/broadcast/",
        )
        os.environ.setdefault(
            "CYT_BROADCAST_SECRET",
            getattr(settings, "CYT_BROADCAST_SECRET", ""),
        )

        from apps.mcp_server.server import run_stdio

        asyncio.run(run_stdio())
