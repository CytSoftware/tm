"""Read a company's name and one-line description off its website.

Backs the "Fill from website" button: the browser can't read another
origin's HTML, so the server fetches the page head and returns
``og:site_name``/``<title>`` and ``og:description``/``meta description``.
Nothing is stored — the edit dialog shows the result for a person to keep or
change.

The URL is user-supplied, so the fetch refuses anything that resolves to a
non-public address (loopback, private ranges, link-local/metadata), re-checks
every redirect hop, and reads at most ``MAX_BYTES``.
"""

from __future__ import annotations

import ipaddress
import socket
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx

TIMEOUT = 6.0
MAX_BYTES = 400_000
MAX_REDIRECTS = 4
# A plain browser UA: plenty of company sites sit behind bot filters that 403
# anything self-identifying.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0 Safari/537.36"
)


class PreviewError(Exception):
    pass


def normalize_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise PreviewError("Enter a website first.")
    if "://" not in url:
        url = f"https://{url}"
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PreviewError("Not a web address.")
    return url


def _check_public(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise PreviewError(f"Couldn't find {host}.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise PreviewError("That address isn't a public website.")


class _HeadParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            a = {k.lower(): (v or "") for k, v in attrs}
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _clean(text: str, limit: int) -> str:
    text = " ".join(unescape(text).split())
    if len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0] + "…"
    return text


def _fetch_head(url: str) -> tuple[str, str]:
    """Return (final_url, html_head) following redirects by hand so every
    hop is checked against non-public addresses."""
    with httpx.Client(
        timeout=TIMEOUT,
        follow_redirects=False,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en",
        },
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            _check_public(urlsplit(url).hostname or "")
            with client.stream("GET", url) as resp:
                if resp.is_redirect and resp.headers.get("location"):
                    url = urljoin(url, resp.headers["location"])
                    if urlsplit(url).scheme not in ("http", "https"):
                        raise PreviewError("The site redirected somewhere odd.")
                    continue
                if resp.status_code >= 400:
                    raise PreviewError(f"The site answered {resp.status_code}.")
                if "html" not in resp.headers.get("content-type", "html"):
                    raise PreviewError("That address isn't a web page.")
                body = b""
                for chunk in resp.iter_bytes():
                    body += chunk
                    if len(body) >= MAX_BYTES or b"</head>" in body.lower():
                        break
                encoding = resp.encoding or "utf-8"
                return url, body.decode(encoding, errors="replace")
    raise PreviewError("Too many redirects.")


def preview_site(raw_url: str) -> dict:
    url = normalize_url(raw_url)
    try:
        final_url, html = _fetch_head(url)
    except httpx.HTTPError:
        raise PreviewError("Couldn't reach the site.")
    parser = _HeadParser()
    try:
        parser.feed(html)
    except Exception:  # malformed markup still leaves what was parsed
        pass
    m = parser.meta
    name = m.get("og:site_name") or m.get("application-name") or ""
    if not name and parser.title:
        # "Acme — Build faster | Home" → "Acme": cut at the earliest separator.
        title = parser.title.strip()
        cuts = [i for sep in (" | ", " – ", " — ", " - ", " · ", ": ") if (i := title.find(sep)) > 0]
        name = title[: min(cuts)] if cuts else title
    description = m.get("og:description") or m.get("description") or m.get("twitter:description") or ""
    host = (urlsplit(final_url).hostname or "").removeprefix("www.")
    return {
        "url": final_url,
        "domain": host,
        "name": _clean(name, 120),
        "description": _clean(description, 200),
    }
