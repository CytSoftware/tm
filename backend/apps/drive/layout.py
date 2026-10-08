"""The Drive's folder layout — the one place every Drive write path checks.

Top level = one folder per TM project (``Project.drive_folder``; company-wide
files go in ``general/``), then a fixed category, then anything::

    <project>/<category>/[<client>/][<subfolder>/]<file>

The top two levels are locked: nobody uploads or creates folders above a
category. ``to-be-organized/`` is the one exception — where "not sure" uploads
land until someone files them.

Pipeline-owned folders (``SYSTEM_FOLDERS``) and OS/editor junk are hidden from
people and agents alike; ``sources/`` is the LLM-wiki ingest inbox and
``meetings/`` feeds the Meetings app, so neither may move.
"""

from __future__ import annotations

from django.utils.text import slugify

#: Research has no folder of its own: it lives with the domain it serves
#: (market/competitor research → sales, user research → product, regulations →
#: admin), because that's where someone looks for it.
CATEGORIES: dict[str, str] = {
    "brand": "logos, brand guidelines, brand videos, product screenshots",
    "sales": "decks, one-pagers, outreach, campaigns, tenders, GTM strategy, market and competitor research",
    "clients": "one subfolder per client company: contracts, proposals, invoices, client files and calls",
    "product": "specs, demos, demo data, tutorials, bug reports, data exports, customer feedback, product research",
    "fundraising": "accelerators, investor applications and decks, grants",
    "admin": "legal, finance, HR, company registration, regulations, personal documents",
    "archive": "anything superseded — same categories inside",
}

SYSTEM_FOLDERS = ("sources/", "meetings/", "backups/")
INBOX = "to-be-organized/"


def project_folder(project) -> str:
    return project.drive_folder or slugify(project.name)


def project_folders(*, include_archived: bool = True) -> set[str]:
    from apps.tasks.models import Project

    qs = Project.objects.all() if include_archived else Project.objects.filter(archived=False)
    return {project_folder(p) for p in qs}


def is_hidden(key: str) -> bool:
    """System folders and junk (dotfiles, Office lock files, Blender backups)."""
    if key.startswith(SYSTEM_FOLDERS):
        return True
    segments = [s for s in key.split("/") if s]
    return any(s.startswith((".", "~$")) for s in segments) or key.endswith(".blend1")


def check_folder(folder: str) -> str:
    """Normalize a destination folder and refuse anything above category level.

    Returns ``a/b/`` (trailing slash). Raises ``ValueError`` otherwise.
    """
    segments = [s for s in (folder or "").replace("\\", "/").split("/") if s]
    if any(s in (".", "..") for s in segments):
        raise ValueError("Invalid folder.")
    norm = "/".join(segments) + "/" if segments else ""
    if norm.startswith(INBOX) and not is_hidden(norm):
        return norm
    if (
        len(segments) >= 2
        and segments[0] in project_folders()
        and segments[1] in CATEGORIES
        and not is_hidden(norm)
    ):
        return norm
    raise ValueError(
        "Files and folders go inside a project's category, e.g. mowafeq/sales/, "
        f"or in {INBOX} if you're not sure."
    )


def folder_name(name: str) -> str:
    """``"Q4 Decks"`` → ``"q4-decks"``."""
    slug = slugify(name or "")
    if not slug:
        raise ValueError("A folder name is required.")
    return slug


def drive_path(
    project, category: str, filename: str, *, client: str | None = None,
    subfolder: str | None = None,
) -> str:
    """Build the key a file belongs at, refusing anything off-layout."""
    if category not in CATEGORIES:
        raise ValueError(f"category must be one of: {', '.join(CATEGORIES)}.")
    if category == "clients" and not client:
        raise ValueError("category 'clients' needs `client` (the client company's name).")
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or name in (".", ".."):
        raise ValueError("A file name is required.")
    parts = [project_folder(project), category]
    if client:
        parts.append(slugify(client))
    if subfolder:
        parts += [slugify(p) for p in subfolder.split("/") if slugify(p)]
    return "/".join(parts + [name])
