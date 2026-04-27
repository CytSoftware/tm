"""Convert HTML-stored descriptions to markdown.

Phase 1 stored description fields as TipTap-emitted HTML. We're switching
the source-of-truth to markdown so the LLM read/write paths are symmetric
(MCP tools return what an agent would write back). This migration is a
one-time, best-effort conversion using ``markdownify``.

The reverse direction is also best-effort (markdown → HTML via the
``markdown`` library is no longer a dep, so we just wrap as a paragraph)
since reverting in production would require restoring a backup anyway.
"""

from __future__ import annotations

from django.db import migrations


def _html_to_markdown(html: str) -> str:
    if not html:
        return ""
    # Treat the TipTap-empty marker as truly empty.
    if html.strip() == "<p></p>":
        return ""
    # If it doesn't look like HTML at all, leave it untouched — could be
    # legacy plain text or already-markdown content.
    if "<" not in html:
        return html
    from markdownify import markdownify

    md = markdownify(
        html,
        heading_style="ATX",        # `# Heading`
        bullets="-",                # `-` for unordered lists
        code_language="",           # don't guess fences
        strip=["span"],             # drop unstyled inline wrappers
    )
    return md.strip()


def _convert_to_markdown(apps, schema_editor):
    Task = apps.get_model("tasks", "Task")
    RecurringTaskTemplate = apps.get_model("tasks", "RecurringTaskTemplate")

    for model in (Task, RecurringTaskTemplate):
        for row in model.objects.exclude(description="").only("id", "description"):
            converted = _html_to_markdown(row.description)
            if converted != row.description:
                model.objects.filter(pk=row.pk).update(description=converted)


def _revert_to_html(apps, schema_editor):
    """Best-effort reverse: wrap markdown in a single <p> so TipTap renders
    it as plain text rather than crashing. Real recovery should restore a
    pre-migration DB backup."""
    Task = apps.get_model("tasks", "Task")
    RecurringTaskTemplate = apps.get_model("tasks", "RecurringTaskTemplate")

    from html import escape

    for model in (Task, RecurringTaskTemplate):
        for row in model.objects.exclude(description="").only("id", "description"):
            wrapped = f"<p>{escape(row.description)}</p>"
            model.objects.filter(pk=row.pk).update(description=wrapped)


class Migration(migrations.Migration):

    dependencies = [
        ("tasks", "0013_userprofile_assign_hotkey_bindings"),
    ]

    operations = [
        migrations.RunPython(_convert_to_markdown, _revert_to_html),
    ]
