"""Small helpers shared across the wiki app."""

from __future__ import annotations

from typing import Any


def extract_plain_text(value: Any) -> str:
    """Flatten a Plate/Slate value (list of nodes) into searchable plain text.

    Walks the node tree collecting leaf ``text`` strings, joining inline text
    within a block and separating top-level blocks with newlines. Resilient to
    malformed input — anything unexpected is skipped rather than raising.
    """
    if not isinstance(value, list):
        return ""

    lines: list[str] = []
    for node in value:
        text = _node_text(node)
        if text:
            lines.append(text)
    return "\n".join(lines).strip()


def _node_text(node: Any) -> str:
    if isinstance(node, dict):
        if isinstance(node.get("text"), str):
            return node["text"]
        children = node.get("children")
        if isinstance(children, list):
            return "".join(_node_text(child) for child in children)
    return ""
