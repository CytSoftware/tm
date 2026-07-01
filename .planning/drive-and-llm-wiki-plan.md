# Drive + LLM-Wiki Implementation Plan (no AI / embeddings / synthesis yet)

Status: planning · Target stack: **current** Django 6 + DRF + Channels + FastMCP on **SQLite + InMemoryChannelLayer + locmem** (no Postgres/Redis migration in this scope) · Frontend: Next.js 16 App Router + TanStack Query.

This plan delivers two things on top of the existing tracker:

1. **Phase 1 — `apps/drive`**: a file browser backed by Backblaze **B2** (S3-compatible, via `boto3`) over the `cyt-drive` bucket — DRF endpoints, `drive_*` MCP tools, and a "Drive" frontend tab.
2. **Phase 2 — `apps/knowledge`**: an "LLM Wiki" **shell** (no AI). Markdown pages live in the **same `cyt-drive` bucket** under a **dedicated `llm-wiki/` prefix**; a read-only browser tab renders them; `knowledge_*` MCP tools let an external agent create/update pages on demand (single writer, no synthesis worker).

Everything AI-shaped (embeddings, `knowledge_search`, autonomous ingestion, synthesis worker, Postgres/Redis) is explicitly **deferred** — see the "Later, needs Bedrock" section.

---

## 0. Guiding architecture decisions (read first)

These decisions shape every file below. They intentionally deviate from a few "default" app conventions, and each deviation is justified so a reviewer isn't surprised.

- **B2 is the source of truth — no mirror tables.** Drive files and wiki pages are B2 objects. We do **not** create Django models mirroring them. Consequences:
  - **No new migrations, no schema change → the SQLite + in-memory stack is untouched.** This satisfies the "stay on the current stack" requirement literally: `apps/drive` and `apps/knowledge` ship **zero** `models.py` rows.
  - Listing = `list_objects_v2`; reads/writes/deletes = direct B2 object ops. No drift between DB and bucket, which also removes the need for the deferred "nightly rclone reconcile" *for these two apps*.
  - **No `id_generation.py`, no `admin.py` registrations** (nothing to register), **no human `KEY-NNN`** — the object key *is* the identifier.
- **Direct `boto3`, not `django-storages`.** We need presigned PUT/GET + prefix browsing, which `django-storages`' default-storage abstraction doesn't expose cleanly. We add **`boto3` only**. `STORAGES` in `settings.py` is left as-is, so **avatars/media stay on the local filesystem** (`FileSystemStorage`) and are unaffected. Moving media into B2 later is optional and independent (see deferred).
- **Two disjoint prefixes in one bucket** so the future auto-ingestor never eats its own output (loop prevention):
  - Drive operates under `B2_DRIVE_PREFIX` (recommended `"drive/"`).
  - LLM-wiki pages live under `B2_LLM_WIKI_PREFIX` (`"llm-wiki/"`).
  - The B2 service **hard-excludes** `LLM_WIKI_PREFIX` from every Drive listing/op and refuses Drive keys that resolve under it. Wiki tools only ever touch the wiki prefix.
- **No realtime for Drive/Knowledge in this scope.** Neither app gets a `broadcast.py`/`routing.py`/consumer. This mirrors CRM (which also has no WebSocket). Mutations rely on TanStack `invalidateQueries(["drive"])` / `(["llm-wiki"])`. Adding live sync later means adding a Channels group + consumer + `broadcast.py` following the `apps/tasks/broadcast.py` bridge pattern — deferred.
- **Object keys can contain `/` (and Drive browses by folder).** DRF's default pk/`key` lookup regex chokes on slashes, so Drive endpoints take the object key as a **query/body parameter**, not a URL path segment. This is why Drive uses plain `APIView`s mounted with `path()` (the same convention as `UploadImageView` and the integrations webhook) rather than a `ModelViewSet` router.
- **Auth stays as-is.** DRF `IsAuthenticated` (session) protects every endpoint; MCP tools authenticate via the existing Bearer/OAuth path and read `_get_mcp_user()`. B2 has no per-user attribution in this scope; `mcp_user` is threaded through for future audit logging only.

---

## 1. Shared plumbing (do once, before Phase 1 code)

### 1a. Add the dependency (uv)

```bash
cd /home/ali/Cyt/tm/backend
uv add boto3
```

**File: `/home/ali/Cyt/tm/backend/pyproject.toml`** — `uv add` inserts `"boto3>=1.34.0"` into `dependencies` and updates `uv.lock`. The Dockerfile already runs `uv sync --frozen`, so no Dockerfile change is needed. (Do **not** add `django-storages` — see decision above.)

### 1b. B2 settings + env readers

**File: `/home/ali/Cyt/tm/backend/core/settings.py`** — insert a new block **immediately after the `STORAGES = {…}` dict (currently ends at line 166)**, following the existing `_os.environ.get(...)` convention used for CORS/broadcast/MCP config. Do **not** override `STORAGES`.

```python
# ---------------------------------------------------------------------------
# Backblaze B2 (S3-compatible) — Drive + LLM-wiki object storage
# ---------------------------------------------------------------------------
# One bucket (cyt-drive), two disjoint prefixes. All read from env; empty
# endpoint/bucket disables the feature (endpoints return 503). Secrets live in
# Dokploy env only — never commit the app key. See .planning docs.
B2_ENDPOINT_URL = _os.environ.get("B2_ENDPOINT_URL", "")      # e.g. https://s3.us-west-001.backblazeb2.com
B2_REGION_NAME  = _os.environ.get("B2_REGION_NAME", "us-west-001")
B2_KEY_ID       = _os.environ.get("B2_KEY_ID", "")            # Application Key ID
B2_APP_KEY      = _os.environ.get("B2_APP_KEY", "")           # Application Key secret
B2_BUCKET_NAME  = _os.environ.get("B2_BUCKET_NAME", "")       # cyt-drive
B2_DRIVE_PREFIX = _os.environ.get("B2_DRIVE_PREFIX", "drive/")      # trailing slash
B2_LLM_WIKI_PREFIX = _os.environ.get("B2_LLM_WIKI_PREFIX", "llm-wiki/")
B2_PRESIGN_EXPIRY = int(_os.environ.get("B2_PRESIGN_EXPIRY", "3600"))  # seconds
```

> **Discovered values (from the config spec — confirm in the B2 dashboard, do NOT hardcode secrets):** the existing rclone `s3` remote uses Application **Key ID** `003ba4af47649a80000000010`; the secret app key exists but is masked (set it only in Dokploy). Endpoint/region are most likely `https://s3.us-west-001.backblazeb2.com` / `us-west-001` but must be verified against the bucket's actual region. Bucket name is expected to be `cyt-drive`.

### 1c. Wire env into compose + document it

- **File: `/home/ali/Cyt/tm/docker-compose.yml`** — add to the `backend.environment` list (mirroring the existing `${VAR:-default}` style):
  ```yaml
      - B2_ENDPOINT_URL=${B2_ENDPOINT_URL:-}
      - B2_REGION_NAME=${B2_REGION_NAME:-us-west-001}
      - B2_KEY_ID=${B2_KEY_ID:-}
      - B2_APP_KEY=${B2_APP_KEY:-}
      - B2_BUCKET_NAME=${B2_BUCKET_NAME:-}
      - B2_DRIVE_PREFIX=${B2_DRIVE_PREFIX:-drive/}
      - B2_LLM_WIKI_PREFIX=${B2_LLM_WIKI_PREFIX:-llm-wiki/}
  ```
- **File: `/home/ali/Cyt/tm/backend/.env`** (gitignored, local dev only) — add the same keys with real dev values so `settings.py`'s `.env` bootstrap picks them up.
- **Dokploy (backend app env, production):** set `B2_ENDPOINT_URL`, `B2_REGION_NAME`, `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_NAME`, `B2_DRIVE_PREFIX`, `B2_LLM_WIKI_PREFIX`. `B2_APP_KEY` is the only true secret.
- **File: `/home/ali/Cyt/tm/CLAUDE.md`** — append the seven `B2_*` vars to the backend "Environment variables" list for future contributors (documentation only).

---

## Phase 1 — `apps/drive`

### 1.1 Backend app scaffold

**File: `/home/ali/Cyt/tm/backend/apps/drive/__init__.py`** — empty.

**File: `/home/ali/Cyt/tm/backend/apps/drive/apps.py`** — minimal `AppConfig` (no `ready()` — no signals, no models):
```python
from django.apps import AppConfig

class DriveConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.drive"
    label = "drive"
```

**No `models.py`, no `migrations/`, no `admin.py`, no `broadcast.py`, no `query.py`, no `id_generation.py`.** (Justified in §0. A trivial empty `models.py` may be added to satisfy tooling expectations, but is not required since the app declares no models.)

### 1.2 The B2 service module (the core of Phase 1)

**File: `/home/ali/Cyt/tm/backend/apps/drive/b2.py`** — the single source of truth for all B2 access, shared by the DRF views **and** the MCP tools **and** (Phase 2) the knowledge app. Mirrors the "one shared helper module, no duplicated logic" ethos of `apps/tasks/query.py`.

Contents:

- **Cached client factory** (module-level `functools.lru_cache`) so a boto3 client is built once per process:
  ```python
  import functools, boto3
  from botocore.config import Config
  from django.conf import settings

  class B2NotConfigured(RuntimeError): ...

  @functools.lru_cache(maxsize=1)
  def client():
      if not (settings.B2_ENDPOINT_URL and settings.B2_BUCKET_NAME):
          raise B2NotConfigured("B2_ENDPOINT_URL / B2_BUCKET_NAME are unset")
      return boto3.client(
          "s3",
          endpoint_url=settings.B2_ENDPOINT_URL,
          region_name=settings.B2_REGION_NAME,
          aws_access_key_id=settings.B2_KEY_ID,
          aws_secret_access_key=settings.B2_APP_KEY,
          config=Config(signature_version="s3v4",
                        s3={"addressing_style": "path"}),  # path-style is safest with a custom endpoint
      )
  def is_configured() -> bool: ...
  ```
- **Prefix guards** (loop-prevention + traversal safety):
  ```python
  def _norm(rel: str) -> str:                 # strip leading '/', reject '..'
  def drive_key(rel: str) -> str:             # DRIVE_PREFIX + _norm(rel); raises if it lands under LLM_WIKI_PREFIX
  def wiki_key(slug: str) -> str:             # LLM_WIKI_PREFIX + slug + '.md'  (used by Phase 2)
  def _strip_drive_prefix(key: str) -> str:   # back to a browser-relative path
  ```
- **Object operations** (all take/return plain dicts, never boto3 objects — same "JSON-serializable only" rule the MCP tools require):
  - `list_objects(rel_prefix="", *, delimiter="/", token=None, limit=1000) -> dict` → wraps `list_objects_v2(Bucket, Prefix=drive_key(rel_prefix), Delimiter=delimiter, ContinuationToken=token)`. Returns:
    ```python
    {"prefix": rel_prefix,
     "folders": [ "<name>/", ... ],          # from CommonPrefixes, drive-relative
     "files":   [ {"key","name","size","last_modified","content_type"?}, ... ],
     "next_token": <str|None>}
    ```
    Skips the folder-marker object equal to the prefix itself, and **filters out anything under `LLM_WIKI_PREFIX`** defensively.
  - `presign_put(rel, content_type, *, expires=None) -> dict` → `generate_presigned_url("put_object", Params={Bucket, Key, ContentType}, ExpiresIn=...)`. Returns `{"url","key","method":"PUT","headers":{"Content-Type":content_type}}`. Signing the content type means the browser **must** send that exact header (documented in the hook).
  - `presign_get(rel, *, expires=None, download_name=None) -> str` → `generate_presigned_url("get_object", Params={Bucket, Key, ResponseContentDisposition?})`.
  - `head(rel) -> dict|None` → `head_object` metadata (size/type/last_modified) or `None` on 404.
  - `put_bytes(rel, data: bytes, content_type) -> dict` → `put_object` (used by MCP `drive_upload` where the agent supplies content inline; browsers use presigned PUT instead).
  - `get_bytes(rel, *, max_bytes=None) -> bytes` → `get_object` body read (used by MCP `drive_read` inline text + Phase 2 wiki reads).
  - `delete(rel) -> dict` → `delete_object`; returns `{"deleted": rel}`. **Note: the B2 bucket has hard-delete enabled — irreversible.**

  All ops wrap `botocore.exceptions.ClientError` and re-raise as a small `B2Error` with a clean message (so DRF/MCP surface a readable error, per the MCP "raise with clear messages" convention).

### 1.3 Serializers (request validation + OpenAPI, no ModelSerializer)

**File: `/home/ali/Cyt/tm/backend/apps/drive/serializers.py`** — plain `serializers.Serializer` classes (there is no model to bind):
- `UploadUrlRequestSerializer`: `path` (CharField, the folder-relative destination), `content_type` (CharField, default `application/octet-stream`).
- `DeleteRequestSerializer`: `key` (CharField).
- Lightweight response serializers (`DriveObjectSerializer`, `DriveListSerializer`) are optional but recommended so `drf-spectacular` produces a usable schema (project already uses `drf_spectacular`).

### 1.4 DRF views

**File: `/home/ali/Cyt/tm/backend/apps/drive/views.py`** — four `APIView`s (default `IsAuthenticated` from settings applies). Each first checks `b2.is_configured()` and returns **503** with a clear message if B2 env is unset (matches the "empty secret disables feature" convention). Errors from `b2.py` map to 400/404/502.

- `DriveListView(APIView).get` → reads `?prefix=`, `?token=`; returns `b2.list_objects(prefix, token=token)`.
- `DriveUploadUrlView(APIView).post` → validates `UploadUrlRequestSerializer`; returns `b2.presign_put(path, content_type)`. (Client then PUTs the file bytes straight to B2.)
- `DriveDownloadUrlView(APIView).get` → reads `?key=`; returns `{"url": b2.presign_get(key, download_name=basename)}`.
- `DriveDeleteView(APIView).delete` (or `.post`) → validates `DeleteRequestSerializer`; returns `b2.delete(key)`.

No `perform_create`/broadcast hooks (no realtime; no model). Wrap nothing in `transaction.atomic` (no DB writes).

### 1.5 URL wiring

**File: `/home/ali/Cyt/tm/backend/apps/drive/urls.py`** — `path()`-based (no router; keys carry slashes):
```python
from django.urls import path
from .views import DriveListView, DriveUploadUrlView, DriveDownloadUrlView, DriveDeleteView

urlpatterns = [
    path("drive/objects/",      DriveListView.as_view(),        name="drive-list"),
    path("drive/upload-url/",   DriveUploadUrlView.as_view(),   name="drive-upload-url"),
    path("drive/download-url/", DriveDownloadUrlView.as_view(), name="drive-download-url"),
    path("drive/delete/",       DriveDeleteView.as_view(),      name="drive-delete"),
]
```

**File: `/home/ali/Cyt/tm/backend/core/settings.py`** — add `"apps.drive",` to `INSTALLED_APPS` in the "Local apps" block (line 78–84), e.g. right after `"apps.crm",` to keep rough alphabetical order.

**File: `/home/ali/Cyt/tm/backend/core/urls.py`** — add to `urlpatterns` (line 166–170 group), with the project's comment style:
```python
    path("api/", include("apps.drive.urls")),          # /api/drive — B2 file browser
```

### 1.6 `drive_*` MCP tools

Follows the two-layer FastMCP pattern exactly: sync impls in `tools.py`, async wrappers in `server.py`. No broadcast (no realtime). Return shapes follow the documented conventions (list→`list[dict]`, read→`dict`, delete→`{"ok"/"deleted", ...}`).

**File: `/home/ali/Cyt/tm/backend/apps/mcp_server/tools.py`** — append a new section (mirroring the existing "Wiki (docs)" section at line ~1505), importing lazily from `apps.drive.b2`:
```python
# --- Drive (B2 object storage) --------------------------------------------
def drive_list(prefix: str = "", token: str | None = None) -> dict[str, Any]:
    """List Drive folders + files under a prefix (B2)."""
    from apps.drive import b2
    return b2.list_objects(prefix, token=token)

def drive_read(key: str, max_bytes: int = 65536) -> dict[str, Any]:
    """Return a Drive object's metadata + presigned GET URL; inline UTF-8 text if small."""
    from apps.drive import b2
    meta = b2.head(key) or {}
    out = {"key": key, **meta, "url": b2.presign_get(key)}
    # best-effort inline text for texty/small objects
    ...
    return out

def drive_upload(key: str, content: str = "", content_base64: str | None = None,
                 content_type: str = "text/plain; charset=utf-8", mcp_user=None) -> dict[str, Any]:
    """Create/overwrite a Drive object with inline content (agents can't PUT a presigned URL)."""
    from apps.drive import b2
    data = base64.b64decode(content_base64) if content_base64 else content.encode("utf-8")
    return b2.put_bytes(key, data, content_type)   # {"ok": True, "key":..., "size":...}

def drive_delete(key: str) -> dict[str, Any]:
    """Delete a Drive object (irreversible — bucket hard-delete is on)."""
    from apps.drive import b2
    return {"ok": True, **b2.delete(key)}
```

**File: `/home/ali/Cyt/tm/backend/apps/mcp_server/server.py`** — append four `@mcp.tool()` async wrappers next to the wiki tools (after line ~893), each a one-liner over `_async(tools.drive_*)`, with docstrings that become the tool descriptions. `drive_upload` passes `mcp_user=_get_mcp_user()` for future attribution:
```python
@mcp.tool()
async def drive_list(prefix: str = "", token: str | None = None) -> dict[str, Any]:
    """List Drive folders and files under a prefix (Backblaze B2). ..."""
    return await _async(tools.drive_list)(prefix=prefix, token=token)
# ... drive_read, drive_upload (with mcp_user=_get_mcp_user()), drive_delete
```
No changes to `core/asgi.py` (auth/transport already handle new tools).

### 1.7 Frontend "Drive" tab

**File: `/home/ali/Cyt/tm/frontend/src/lib/query-keys.ts`** — append (mirroring the `wiki*` keys at line 68–72):
```typescript
// Drive — B2 object browser (no realtime; invalidate the ["drive"] namespace).
export const driveListKey = (prefix = "") => ["drive", "list", prefix] as const;
```

**File: `/home/ali/Cyt/tm/frontend/src/hooks/use-drive.ts`** (new) — TanStack query + mutations via `apiFetch`, following `use-wiki.ts`:
- Types `DriveObject`, `DriveListResponse` (`{prefix, folders, files, next_token}`).
- `useDriveList(prefix)` → `useQuery(driveListKey(prefix), apiFetch("/api/drive/objects/", {query:{prefix}}))`.
- `useUploadFile()` → **two-step presigned PUT**:
  1. `apiFetch("/api/drive/upload-url/", {method:"POST", body:{path, content_type:file.type}})` → `{url, headers}`.
  2. `fetch(url, {method:"PUT", body:file, headers})` — **raw `fetch`, not `apiFetch`** (cross-origin to B2; no cookies/CSRF; must send the exact `Content-Type` that was signed).
  3. `onSuccess` → `qc.invalidateQueries({queryKey:["drive"]})`.
- `useDeleteObject()` → `apiFetch("/api/drive/delete/", {method:"DELETE", body:{key}})`, invalidates `["drive"]`.
- `downloadObject(key, name)` helper → `apiFetch("/api/drive/download-url/", {query:{key}})` then anchor-click `url`.

**File: `/home/ali/Cyt/tm/frontend/src/app/drive/page.tsx`** (new, `"use client"`) — two-pane `h-full flex min-h-0` layout (copy the invariant structure from `wiki/page.tsx`): left `aside w-72 shrink-0 border-r flex flex-col min-h-0` with breadcrumb + folder/file list + "Upload" button (`<input type=file hidden>`); right `main flex-1 min-w-0 min-h-0` showing selected-file metadata + Download/Delete. Folder rows drill into `prefix`; every scroll container carries `min-h-0`/`overflow-y-auto`.

**File: `/home/ali/Cyt/tm/frontend/src/components/layout/Sidebar.tsx`** — insert a `NavLink` right after the "Wiki" one (ends line 353), using `HardDrive` from `lucide-react` (add to the existing `lucide-react` import at line ~26–41):
```tsx
<NavLink
  icon={<HardDrive className={isCollapsed ? "size-4" : "size-3.5 shrink-0 text-muted-foreground"} />}
  label="Drive"
  active={pathname.startsWith("/drive")}
  collapsed={isCollapsed}
  onNavigate={() => { router.push("/drive"); onClose?.(); }}
/>
```

### 1.8 One-time B2 bucket ops (not code — required for browser direct upload/download)

Because the browser PUTs/GETs **directly** to B2 with presigned URLs, the `cyt-drive` bucket needs a **CORS rule** allowing the frontend origin(s), methods `GET,PUT,HEAD`, and headers `Content-Type` + range. Set via the B2 dashboard or `b2 bucket update-cors` / rclone. Without it, browsers fail with CORS errors (see Risks). Fallback if CORS can't be configured: proxy uploads/downloads through Django (bytes flow through the backend) — more load, no CORS needed.

---

## Phase 2 — `apps/knowledge` (LLM Wiki shell, no AI)

Markdown pages stored as B2 objects at `llm-wiki/<slug>.md` in the **same `cyt-drive` bucket**. Humans get a **read-only** browser tab; external agents create/update pages via MCP (single writer, no synthesis).

### 2.1 Backend app scaffold

**File: `/home/ali/Cyt/tm/backend/apps/knowledge/__init__.py`** — empty.
**File: `/home/ali/Cyt/tm/backend/apps/knowledge/apps.py`** — `KnowledgeConfig(name="apps.knowledge", label="knowledge")`, no `ready()`. No models/migrations/admin (same rationale as Drive).

### 2.2 Knowledge service (reuses the Drive B2 client)

**File: `/home/ali/Cyt/tm/backend/apps/knowledge/service.py`** — thin wiki-page helpers built on `apps.drive.b2` (import its cached `client()` + `wiki_key()` + `get_bytes`/`put_bytes`/`list_objects`-style ops). This keeps a single boto3 client and honors the "no duplicated storage logic" principle.
- `list_pages() -> list[dict]` → list objects under `LLM_WIKI_PREFIX`, return `[{"slug","title","size","updated_at"}]`. `slug` = key minus prefix minus `.md`; `title` = first `# ` heading of the body if cheaply available, else the slug (Phase 2 keeps it simple: title = slug; heading extraction optional).
- `read_page(slug) -> dict` → `{"slug","title","markdown","updated_at"}` from `get_bytes(wiki_key(slug))` decoded UTF-8; raises a clean 404-style error if missing.
- `write_page(slug, markdown, *, title=None) -> dict` → `put_bytes(wiki_key(slug), markdown.encode("utf-8"), "text/markdown; charset=utf-8")`; returns `{"ok":True,"slug","size"}`. Single writer, last-write-wins (documented).
- `slugify(name)` guard so slugs can't traverse or escape the prefix.

### 2.3 DRF views (read-only for humans)

**File: `/home/ali/Cyt/tm/backend/apps/knowledge/views.py`** — two read `APIView`s (`IsAuthenticated`, B2-configured guard like Drive):
- `KnowledgePageListView.get` → `service.list_pages()`.
- `KnowledgePageDetailView.get` → `service.read_page(slug)`; `slug` comes from the URL (slugs are safe path segments — no slashes — so a path capture is fine here, unlike Drive keys).

No write endpoints on the human API (writes are MCP-only in this scope).

**File: `/home/ali/Cyt/tm/backend/apps/knowledge/urls.py`**:
```python
urlpatterns = [
    path("knowledge/pages/",              KnowledgePageListView.as_view(),   name="knowledge-list"),
    path("knowledge/pages/<slug:slug>/",  KnowledgePageDetailView.as_view(), name="knowledge-detail"),
]
```

**File: `/home/ali/Cyt/tm/backend/core/settings.py`** — add `"apps.knowledge",` to `INSTALLED_APPS` (Local apps block).
**File: `/home/ali/Cyt/tm/backend/core/urls.py`** — add:
```python
    path("api/", include("apps.knowledge.urls")),      # /api/knowledge — LLM-wiki (B2 llm-wiki/ prefix, read-only)
```

### 2.4 `knowledge_*` MCP tools

**File: `/home/ali/Cyt/tm/backend/apps/mcp_server/tools.py`** — append a "Knowledge (LLM-wiki)" section importing `apps.knowledge.service`:
- `knowledge_list() -> list[dict]` → `service.list_pages()`.
- `knowledge_read(slug: str) -> dict` → `service.read_page(slug)`.
- `knowledge_write(slug: str, markdown: str, title: str | None = None, mcp_user=None) -> dict` → `service.write_page(...)`. (Single writer; overwrites. Aliased as `knowledge_add` if we want a distinct "create" verb — same impl.)

**File: `/home/ali/Cyt/tm/backend/apps/mcp_server/server.py`** — three `@mcp.tool()` async wrappers (`knowledge_write` passes `mcp_user=_get_mcp_user()`), docstrings noting pages persist to the `llm-wiki/` prefix and are single-writer with no synthesis worker.

### 2.5 Frontend "LLM Wiki" tab (read-only)

**File: `/home/ali/Cyt/tm/frontend/src/lib/query-keys.ts`** — append:
```typescript
export const llmWikiListKey = () => ["llm-wiki", "list"] as const;
export const llmWikiPageKey = (slug: string) => ["llm-wiki", "page", slug] as const;
```

**File: `/home/ali/Cyt/tm/frontend/src/hooks/use-knowledge.ts`** (new) — **query-only** (no mutations; agents write):
- `useKnowledgeList()` → `apiFetch("/api/knowledge/pages/")`.
- `useKnowledgePage(slug)` → `apiFetch("/api/knowledge/pages/${slug}/")`, `enabled: !!slug`.

**File: `/home/ali/Cyt/tm/frontend/src/app/llm-wiki/page.tsx`** (new, `"use client"`) — same two-pane `h-full/min-h-0` layout as Wiki, but the right pane **renders markdown read-only**. Use the already-present **`markdown-it`** dep (+ `remark-gfm` is present too) to convert `page.markdown` → HTML inside a `prose`-styled `overflow-y-auto min-h-0` container. No editor, no upload, no delete.

**File: `/home/ali/Cyt/tm/frontend/src/components/layout/Sidebar.tsx`** — add a `NavLink` after "Drive", icon `Sparkles` (or `Brain`) from `lucide-react`, `active={pathname.startsWith("/llm-wiki")}`, `router.push("/llm-wiki")`.

---

## Later, needs Bedrock (DEFERRED — do NOT build in this scope)

Brief pointers only; each is its own future phase and most require the Postgres/Redis/worker migration the current stack intentionally avoids:

- **Embeddings + pgvector + `knowledge_search`** — needs Bedrock embeddings, a Postgres+pgvector store, and a `knowledge_search` MCP tool.
- **Autonomous ingestion** — B2 event-notification webhook + a standard-wiki on-save hook + a nightly `rclone` reconcile job that ingests Drive/standard-wiki content into the LLM-wiki. The `drive/` vs `llm-wiki/` prefix split (built in Phase 1/2) is precisely what stops this from looping.
- **Karpathy-style synthesis worker** — a background worker that reads sources and rewrites/merges LLM-wiki pages (moves off the "single writer" assumption).
- **Infra migration** — Postgres (durable + pgvector), Redis (`channels_redis` + a real task queue for the worker). Keep new code free of SQLite-only assumptions so the swap stays clean (per existing CLAUDE.md guidance).

---

## Risks & decisions

- **Bucket CORS is a hard prerequisite for browser presigned PUT/GET.** If the `cyt-drive` bucket lacks a CORS rule for the frontend origin, direct uploads/downloads fail in-browser. Decision: configure bucket CORS (§1.8); documented Django-proxy fallback if that's not possible.
- **Presigned-PUT content-type coupling.** Signing `ContentType` into the PUT URL means the browser must send that exact header. The upload hook sets it from `file.type`; a mismatch → 403 from B2. Documented in the hook.
- **Hard delete is irreversible.** The B2 setup has `hard_delete=true`; `drive_delete`/`DriveDeleteView`/`knowledge` overwrites are unrecoverable. Consider a confirm dialog (already in the Drive page skeleton) and, later, versioning/lifecycle rules.
- **No mirror table → listing cost + eventual consistency.** Every Drive listing hits B2 `list_objects_v2` (network latency; paginated at 1000). Acceptable for a low-volume internal tool; TanStack `staleTime: 30s` cushions it. If it grows, a cached index (or the deferred DB mirror) can be added.
- **Deviation from "every write broadcasts."** Drive/Knowledge skip Channels broadcasts (no consumer). Justified: parity with CRM + no cross-tab realtime requirement yet. Adding it later is additive (new group + consumer + `broadcast.py`).
- **Deviation from `django-storages` recommendation.** We use raw `boto3` for presign/browse and keep avatars on local disk. Smaller blast radius; media-to-B2 remains an independent future option.
- **Single-writer LLM-wiki.** `knowledge_write` is last-write-wins with no locking; fine for one agent. Concurrent writers could clobber — the synthesis worker phase must add coordination.
- **Object keys with slashes.** Handled by passing keys as query/body params (not URL path) and using `APIView`s; avoids DRF lookup-regex breakage.
- **Secret hygiene.** `B2_APP_KEY` only in Dokploy/`.env` (gitignored). The discovered Key **ID** is not a secret; the app key secret must never be committed.

## Open questions

1. **Confirm B2 endpoint/region and bucket name.** Is it `s3.us-west-001.backblazeb2.com` / `us-west-001` / `cyt-drive`? (rclone config had the key ID but not the region/bucket.)
2. **`B2_DRIVE_PREFIX` value** — `"drive/"` (recommended, disjoint sibling of `llm-wiki/`) or the bucket root `""` (then Drive must *exclude* `llm-wiki/` on every op — already handled, but root is riskier)?
3. **Upload path: presigned PUT (chosen) vs. server-proxied?** Presigned offloads bandwidth but requires bucket CORS. If CORS is a blocker in this environment, do we ship the Django-proxy fallback for Phase 1 instead?
4. **Folder semantics** — do we need explicit "create folder" (zero-byte marker objects), or is folder-on-first-upload (implicit via key prefixes) enough for the browser?
5. **LLM-wiki page title source** — derive from the first `# ` heading (extra read per list item) or keep title = slug in this shell phase?
6. **Do we want `knowledge_delete` / `drive` rename+move** MCP tools now, or defer until the agent workflow actually needs them?
7. **Should any file-type / size limits** be enforced on Drive uploads (the tasks image upload validates type/size — Drive currently accepts anything)?
