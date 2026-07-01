"""Backblaze B2 (S3-compatible) access for the Drive + LLM-wiki apps.

Single source of truth for all bucket I/O. **B2 is authoritative** — there are
no Django models mirroring objects; an object's key *is* its identity, so these
apps ship zero migrations and leave the SQLite stack untouched.

One bucket (``cyt-drive``), two disjoint prefixes:

* Drive operates under ``settings.B2_DRIVE_PREFIX`` (empty = bucket root).
* LLM-wiki pages live under ``settings.B2_LLM_WIKI_PREFIX`` (``llm-wiki/``).

Every Drive operation hard-excludes the wiki prefix (so the future
auto-ingestor never eats its own output) and the rclone ``.Trash-1000/`` folder
(so internal trash never appears in the browser).

All object ops return plain JSON-serialisable dicts (never boto3 objects), so
they can be handed straight to DRF ``Response`` or an MCP tool result.
"""

from __future__ import annotations

import functools
import re
from typing import Any

from django.conf import settings


class B2Error(RuntimeError):
    """A client/validation failure — surfaced to DRF/MCP as HTTP 400."""

    status_code = 400


class B2NotConfigured(B2Error):
    """B2 env vars are unset — the feature is disabled (endpoints return 503)."""

    status_code = 503


class B2Upstream(B2Error):
    """A failure from B2 itself (transient/service error) — surfaced as 5xx."""

    status_code = 502


class B2NotFound(B2Error):
    """Requested object does not exist — surfaced as HTTP 404."""

    status_code = 404


def _upstream(exc: Exception) -> B2Upstream:
    """Wrap a boto/botocore error, preserving B2's HTTP status when present."""
    err = B2Upstream(str(exc))
    resp = getattr(exc, "response", None) or {}
    code = (resp.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    if isinstance(code, int) and code >= 400:
        err.status_code = code
    return err


def is_configured() -> bool:
    return bool(settings.B2_ENDPOINT_URL and settings.B2_BUCKET_NAME)


@functools.lru_cache(maxsize=1)
def client():
    """Build (once per process) a boto3 S3 client pointed at B2."""
    if not is_configured():
        raise B2NotConfigured("B2_ENDPOINT_URL / B2_BUCKET_NAME are unset")
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.B2_ENDPOINT_URL,
        region_name=settings.B2_REGION_NAME,
        aws_access_key_id=settings.B2_KEY_ID,
        aws_secret_access_key=settings.B2_APP_KEY,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},  # safest with a custom endpoint
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


# ---------------------------------------------------------------------------
# prefix / key guards
# ---------------------------------------------------------------------------


def _bucket() -> str:
    return settings.B2_BUCKET_NAME


def _drive_prefix() -> str:
    return settings.B2_DRIVE_PREFIX or ""


def _excluded() -> tuple[str, ...]:
    # Never listed or touched through Drive: the LLM-wiki output prefix and the
    # rclone/nautilus trash folder.
    return tuple(p for p in (settings.B2_LLM_WIKI_PREFIX, ".Trash-1000/") if p)


def _clean(rel: str) -> str:
    """Normalise a relative path: strip leading '/', forbid ``..`` traversal."""
    rel = (rel or "").lstrip("/")
    if any(seg == ".." for seg in rel.split("/")):
        raise B2Error("Invalid path.")
    return rel


def _is_excluded(key: str) -> bool:
    """True if the key is (or is under) an excluded prefix — also matches the
    bare prefix without its trailing slash (a stray object literally named
    ``llm-wiki``)."""
    for p in _excluded():
        if key == p or key == p.rstrip("/") or key.startswith(p):
            return True
    return False


def _reject_excluded(key: str) -> None:
    if _is_excluded(key):
        raise B2Error("That path is not accessible via Drive.")


def full_key(rel: str) -> str:
    """Drive-relative path -> absolute B2 key (adds prefix, rejects excluded)."""
    key = _drive_prefix() + _clean(rel)
    _reject_excluded(key)
    return key


def _rel(key: str) -> str:
    """Absolute B2 key -> drive-relative path (strips the drive prefix)."""
    p = _drive_prefix()
    return key[len(p):] if p and key.startswith(p) else key


# ---------------------------------------------------------------------------
# object operations
# ---------------------------------------------------------------------------


def list_objects(rel_prefix: str = "", *, token: str | None = None,
                 limit: int = 1000) -> dict[str, Any]:
    """List folders (CommonPrefixes) + files under a drive-relative prefix."""
    prefix = _drive_prefix() + _clean(rel_prefix)
    _reject_excluded(prefix)  # fail fast — never page through excluded content
    kwargs: dict[str, Any] = {
        "Bucket": _bucket(),
        "Prefix": prefix,
        "Delimiter": "/",
        "MaxKeys": limit,
    }
    if token:
        kwargs["ContinuationToken"] = token
    try:
        resp = client().list_objects_v2(**kwargs)
    except Exception as exc:  # botocore ClientError etc.
        raise _upstream(exc) from exc

    folders: list[str] = []
    for cp in resp.get("CommonPrefixes", []):
        p = cp.get("Prefix", "")
        if _is_excluded(p):
            continue
        folders.append(_rel(p))

    files: list[dict[str, Any]] = []
    for obj in resp.get("Contents", []):
        k = obj["Key"]
        if k == prefix or k.endswith("/"):
            continue  # skip the folder-marker object itself
        if _is_excluded(k):
            continue
        lm = obj.get("LastModified")
        files.append({
            "key": _rel(k),
            "name": k.rsplit("/", 1)[-1],
            "size": obj.get("Size", 0),
            "last_modified": lm.isoformat() if lm else None,
        })

    return {
        "prefix": rel_prefix,
        "folders": sorted(folders),
        "files": files,
        "next_token": resp.get("NextContinuationToken"),
    }


def presign_put(rel: str, content_type: str = "application/octet-stream",
                *, expires: int | None = None) -> dict[str, Any]:
    """Presigned PUT URL so the browser uploads bytes straight to B2.

    The signed URL pins ``Content-Type`` — the client MUST send that exact
    header on the PUT or B2 returns 403.
    """
    key = full_key(rel)
    if not key or key.endswith("/"):
        raise B2Error("A file name is required.")
    url = client().generate_presigned_url(
        "put_object",
        Params={"Bucket": _bucket(), "Key": key, "ContentType": content_type},
        ExpiresIn=expires or settings.B2_PRESIGN_EXPIRY,
    )
    return {"url": url, "key": _rel(key), "method": "PUT",
            "headers": {"Content-Type": content_type}}


def presign_get(rel: str, *, expires: int | None = None,
                download_name: str | None = None) -> str:
    """Presigned GET URL for downloading an object directly from B2."""
    key = full_key(rel)
    params: dict[str, Any] = {"Bucket": _bucket(), "Key": key}
    if download_name:
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{download_name}"'
        )
    return client().generate_presigned_url(
        "get_object", Params=params,
        ExpiresIn=expires or settings.B2_PRESIGN_EXPIRY,
    )


def head(rel: str) -> dict[str, Any] | None:
    """Object metadata, or ``None`` if it does not exist."""
    key = full_key(rel)
    try:
        r = client().head_object(Bucket=_bucket(), Key=key)
    except Exception as exc:
        resp = getattr(exc, "response", None) or {}
        status = (resp.get("ResponseMetadata") or {}).get("HTTPStatusCode")
        if status == 404:
            return None  # genuinely missing
        raise _upstream(exc) from exc  # don't mask a 5xx as "not found"
    lm = r.get("LastModified")
    return {
        "key": _rel(key),
        "name": key.rsplit("/", 1)[-1],
        "size": r.get("ContentLength", 0),
        "content_type": r.get("ContentType"),
        "last_modified": lm.isoformat() if lm else None,
    }


def get_bytes(rel: str, *, max_bytes: int | None = None) -> bytes:
    key = full_key(rel)
    try:
        r = client().get_object(Bucket=_bucket(), Key=key)
        body = r["Body"]
        return body.read(max_bytes) if max_bytes else body.read()
    except Exception as exc:
        raise _upstream(exc) from exc


def put_bytes(rel: str, data: bytes,
              content_type: str = "application/octet-stream") -> dict[str, Any]:
    key = full_key(rel)
    if not key or key.endswith("/"):
        raise B2Error("A file name is required.")
    try:
        client().put_object(Bucket=_bucket(), Key=key, Body=data,
                            ContentType=content_type)
    except Exception as exc:
        raise _upstream(exc) from exc
    return {"ok": True, "key": _rel(key), "size": len(data)}


def delete(rel: str) -> dict[str, Any]:
    """Delete an object. NOTE: the bucket has hard-delete enabled — irreversible."""
    key = full_key(rel)
    try:
        client().delete_object(Bucket=_bucket(), Key=key)
    except Exception as exc:
        raise _upstream(exc) from exc
    return {"ok": True, "deleted": _rel(key)}


# ---------------------------------------------------------------------------
# LLM-wiki access (the ``llm-wiki/`` prefix)
# ---------------------------------------------------------------------------
#
# Markdown pages live at ``llm-wiki/<slug>.md`` in the SAME bucket. This prefix
# is deliberately EXCLUDED from every Drive operation above (loop-prevention),
# so the wiki gets its own key builder + ops here that intentionally reach into
# it. Agent-owned content — writes come from MCP, humans read only.


def _wiki_prefix() -> str:
    return settings.B2_LLM_WIKI_PREFIX or "llm-wiki/"


_SLUG_RE = re.compile(r"[^a-z0-9._-]+")


def slugify(name: str) -> str:
    slug = _SLUG_RE.sub("-", (name or "").strip().lower()).strip("-.")
    if not slug or ".." in slug or "/" in slug:
        raise B2Error("Invalid page name.")
    return slug


def wiki_key(slug: str) -> str:
    return f"{_wiki_prefix()}{slugify(slug)}.md"


def _title_from_markdown(markdown: str, fallback: str) -> str:
    for line in markdown.splitlines():
        if line.startswith("# "):
            return line[2:].strip() or fallback
    return fallback


def wiki_list() -> list[dict[str, Any]]:
    prefix = _wiki_prefix()
    try:
        pages: list[dict[str, Any]] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": _bucket(), "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            resp = client().list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []):
                k = obj["Key"]
                if not k.endswith(".md"):
                    continue
                slug = k[len(prefix):-3]
                lm = obj.get("LastModified")
                pages.append({
                    "slug": slug,
                    "title": slug,
                    "size": obj.get("Size", 0),
                    "updated_at": lm.isoformat() if lm else None,
                })
            token = resp.get("NextContinuationToken")
            if not token:
                break
    except Exception as exc:
        raise _upstream(exc) from exc
    return sorted(pages, key=lambda p: p["slug"])


def wiki_read(slug: str) -> dict[str, Any]:
    key = wiki_key(slug)
    try:
        r = client().get_object(Bucket=_bucket(), Key=key)
        markdown = r["Body"].read().decode("utf-8")
    except Exception as exc:
        resp = getattr(exc, "response", None) or {}
        if (resp.get("ResponseMetadata") or {}).get("HTTPStatusCode") == 404:
            raise B2NotFound(f"No such wiki page: {slugify(slug)!r}") from exc
        raise _upstream(exc) from exc
    lm = r.get("LastModified")
    norm = slugify(slug)
    return {
        "slug": norm,
        "title": _title_from_markdown(markdown, norm),
        "markdown": markdown,
        "updated_at": lm.isoformat() if lm else None,
    }


def wiki_write(slug: str, markdown: str) -> dict[str, Any]:
    key = wiki_key(slug)
    data = (markdown or "").encode("utf-8")
    try:
        client().put_object(Bucket=_bucket(), Key=key, Body=data,
                            ContentType="text/markdown; charset=utf-8")
    except Exception as exc:
        raise _upstream(exc) from exc
    return {"ok": True, "slug": slugify(slug), "size": len(data)}
