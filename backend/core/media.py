"""Serve MEDIA_ROOT: byte ranges, safe inline/attachment rules, real streaming.

Replaces ``django.views.static.serve`` for three reasons:

* **Range.** Safari will not play a ``<video>`` whose source ignores
  ``Range``, and Chrome cannot seek one.
* **Untrusted types.** ``/api/uploads/`` accepts any file, including ones sent
  in by Mowafeq end users, and media is served from the API origin. Only
  images, video and audio render inline; everything else is a download, so an
  uploaded ``.html`` never runs on this origin. SVG can carry script, so it
  also gets ``Content-Security-Policy: sandbox``.
* **Memory.** Under ASGI, Django buffers a *sync* streaming iterator (what
  ``FileResponse`` and ``static.serve`` produce) into a list before sending,
  i.e. the whole file in RAM. The body here is an async generator, which the
  ASGI handler consumes chunk by chunk.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import re

from django.conf import settings
from django.core.exceptions import SuspiciousFileOperation
from django.http import Http404, HttpResponse, HttpResponseNotModified, StreamingHttpResponse
from django.utils._os import safe_join
from django.utils.http import content_disposition_header, http_date
from django.views.static import was_modified_since

# The extensions the task editor treats as video. Registered explicitly so the
# answer does not depend on the host's /etc/mime.types.
for _ext, _type in (
    (".mp4", "video/mp4"),
    (".m4v", "video/mp4"),
    (".mov", "video/quicktime"),
    (".webm", "video/webm"),
    (".ogv", "video/ogg"),
):
    mimetypes.add_type(_type, _ext)

CHUNK_SIZE = 256 * 1024
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")
_INLINE_PREFIXES = ("image/", "video/", "audio/")


def _parse_range(header: str, size: int) -> tuple[int, int] | None | bool:
    """Return ``(start, end)`` inclusive, ``None`` to ignore the header (serve
    the whole file), or ``False`` when the range cannot be satisfied."""
    match = _RANGE.fullmatch(header.strip())
    if not match:
        return None  # malformed or multi-range: RFC 9110 lets us send 200
    first, last = match.groups()
    if not first and not last:
        return None
    if not first:  # suffix range: the last N bytes
        length = int(last)
        if length == 0 or size == 0:
            return False
        return max(size - length, 0), size - 1
    start = int(first)
    if start >= size:
        return False
    end = int(last) if last else size - 1
    if end < start:
        return None
    return start, min(end, size - 1)


async def _stream(path: str, start: int, length: int):
    f = await asyncio.to_thread(open, path, "rb")
    try:
        await asyncio.to_thread(f.seek, start)
        remaining = length
        while remaining > 0:
            chunk = await asyncio.to_thread(f.read, min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
    finally:
        await asyncio.to_thread(f.close)


def serve_media(request, path: str):
    try:
        full_path = safe_join(settings.MEDIA_ROOT, path)
    except (SuspiciousFileOperation, ValueError):
        raise Http404
    if not os.path.isfile(full_path):
        raise Http404

    stat = os.stat(full_path)
    if not was_modified_since(request.META.get("HTTP_IF_MODIFIED_SINCE"), stat.st_mtime):
        return HttpResponseNotModified()

    content_type, encoding = mimetypes.guess_type(full_path)
    if not content_type or encoding:
        content_type = "application/octet-stream"
    inline = content_type.startswith(_INLINE_PREFIXES)
    last_modified = http_date(stat.st_mtime)
    size = stat.st_size

    start, end = 0, size - 1
    partial = False
    range_header = request.META.get("HTTP_RANGE")
    if_range = request.META.get("HTTP_IF_RANGE")
    if range_header and (not if_range or if_range == last_modified):
        parsed = _parse_range(range_header, size)
        if parsed is False:
            response = HttpResponse(status=416)
            response["Content-Range"] = f"bytes */{size}"
            response["Accept-Ranges"] = "bytes"
            return response
        if parsed is not None:
            start, end = parsed
            partial = True

    length = end - start + 1 if size else 0
    if request.method == "HEAD":
        response = HttpResponse(content_type=content_type)
    else:
        response = StreamingHttpResponse(
            _stream(full_path, start, length), content_type=content_type
        )
    if partial:
        response.status_code = 206
        response["Content-Range"] = f"bytes {start}-{end}/{size}"
    response["Content-Length"] = str(length)
    response["Accept-Ranges"] = "bytes"
    response["Last-Modified"] = last_modified
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Disposition"] = content_disposition_header(
        not inline, os.path.basename(full_path)
    )
    if content_type == "image/svg+xml":
        response["Content-Security-Policy"] = "sandbox"
    return response
