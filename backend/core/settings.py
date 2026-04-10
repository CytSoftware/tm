"""
Django settings for the Cyt task tracker (Phase 1).

This is a local-development-first configuration. For real deployment, set
SECRET_KEY / ALLOWED_HOSTS / CORS origins via environment variables.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Make `apps.tasks`, `apps.mcp_server` importable without an `apps.` prefix
# when the `apps` package is already on sys.path via Django's app loader.
# (We keep the full dotted names in INSTALLED_APPS below.)

SECRET_KEY = "django-insecure--ip3l6p-jti9r8s$sy!lhqi2bzw3ixrwx6(#a=%uf)rz*53+3z"
DEBUG = True
ALLOWED_HOSTS = ["*"]  # dev only

INSTALLED_APPS = [
    # Daphne must come before django.contrib.staticfiles so that `runserver`
    # is replaced by Daphne's ASGI runner. See channels docs.
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "django_filters",
    "drf_spectacular",
    "corsheaders",
    "channels",
    "oauth2_provider",
    # Local apps
    "apps.tasks",
    "apps.mcp_server",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # Safety net: catches overdue recurring templates if the system timer is not configured.
    "apps.tasks.middleware.LazyRecurringMiddleware",
]

ROOT_URLCONF = "core.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "core.wsgi.application"
ASGI_APPLICATION = "core.asgi.application"

# Single-process in-memory channel layer. Fine for Phase 1 / local dev.
# Swap to channels_redis for multi-worker deployments.
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}

import os as _os_early
_db_dir = _os_early.environ.get("DB_DIR", "")
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": Path(_db_dir) / "db.sqlite3" if _db_dir else BASE_DIR / "db.sqlite3",
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# DRF
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 200,
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Cyt Task Tracker API",
    "DESCRIPTION": "Phase 1 of the Cyt internal infrastructure app.",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# ---------------------------------------------------------------------------
# CORS / CSRF
# ---------------------------------------------------------------------------
# In production, set CORS_ALLOWED_ORIGINS and CSRF_TRUSTED_ORIGINS as env vars
# (comma-separated). The admin dashboard needs the backend's own origin in
# CSRF_TRUSTED_ORIGINS to accept login forms.
import os as _os

_cors_env = _os.environ.get("CORS_ALLOWED_ORIGINS", "")
CORS_ALLOWED_ORIGINS = (
    [o.strip() for o in _cors_env.split(",") if o.strip()]
    if _cors_env
    else ["http://localhost:3000", "http://127.0.0.1:3000"]
)
CORS_ALLOW_CREDENTIALS = True

_csrf_env = _os.environ.get("CSRF_TRUSTED_ORIGINS", "")
CSRF_TRUSTED_ORIGINS = (
    [o.strip() for o in _csrf_env.split(",") if o.strip()]
    if _csrf_env
    else ["http://localhost:3000", "http://127.0.0.1:3000"]
)

# Cross-subdomain cookie settings.
# In production (DEBUG=False), the frontend (tm.cytsoftware.com) and backend
# (tm-api.cytsoftware.com) are different origins. Cookies must use:
#   SameSite=None  — so the browser sends them on cross-origin requests
#   Secure=True    — required by browsers when SameSite=None
#   Domain=.cytsoftware.com — so both subdomains can read the cookies
# In local dev (DEBUG=True), use Lax + no domain restriction.
_cookie_domain = _os.environ.get("COOKIE_DOMAIN", "")
if _cookie_domain:
    SESSION_COOKIE_DOMAIN = _cookie_domain
    CSRF_COOKIE_DOMAIN = _cookie_domain

if DEBUG:
    SESSION_COOKIE_SAMESITE = "Lax"
    CSRF_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = False
    CSRF_COOKIE_SECURE = False
else:
    SESSION_COOKIE_SAMESITE = "None"
    CSRF_COOKIE_SAMESITE = "None"
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

# The frontend reads the CSRF cookie via JS, so it cannot be HttpOnly.
CSRF_COOKIE_HTTPONLY = False

# ---------------------------------------------------------------------------
# Recurring-task safety net
# ---------------------------------------------------------------------------
# Minimum interval between lazy middleware scans (seconds). The primary trigger
# is a systemd timer / cron running `python manage.py generate_recurring_tasks`;
# this middleware is only a safety net so templates still fire if that's not set up.
RECURRING_LAZY_SCAN_INTERVAL_SECONDS = 10 * 60

# Simple in-memory cache is enough for the lazy-scan timestamp in Phase 1.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "cyt-tm-local",
    }
}

# ---------------------------------------------------------------------------
# Cross-process broadcast bridge
# ---------------------------------------------------------------------------
# Phase 1 runs the MCP server in a separate process from daphne. Because the
# in-memory channel layer is process-local, MCP-driven mutations can't reach
# the browser via the normal Channels path. The MCP process POSTs to
# /api/internal/broadcast/ instead, which uses this shared secret to
# authenticate. Rotate in production; defaults to a local-dev value here.
import os as _os

CYT_BROADCAST_SECRET = _os.environ.get(
    "CYT_BROADCAST_SECRET", "dev-broadcast-secret-change-me"
)

# ---------------------------------------------------------------------------
# Remote MCP authentication
# ---------------------------------------------------------------------------
# Token for authenticating remote MCP clients connecting via HTTP at /mcp/.
# Set CYT_MCP_TOKEN in the environment. When empty, the MCP endpoint is open
# (fine for local dev; lock it down for production).
CYT_MCP_TOKEN = _os.environ.get("CYT_MCP_TOKEN", "")

# ---------------------------------------------------------------------------
# OAuth 2.0 (django-oauth-toolkit)
# ---------------------------------------------------------------------------
OAUTH2_PROVIDER = {
    "SCOPES": {"read": "Read access", "write": "Read+Write access"},
    "DEFAULT_SCOPES": ["read", "write"],
    "ACCESS_TOKEN_EXPIRE_SECONDS": 3600,  # 1 hour
    "REFRESH_TOKEN_EXPIRE_SECONDS": 86400 * 30,  # 30 days
    "ROTATE_REFRESH_TOKEN": True,
    "ALLOWED_REDIRECT_URI_SCHEMES": ["http", "https"],
    # Let DRF handle authentication for non-OAuth views; OAuth views use their
    # own authentication backend automatically.
    "OAUTH2_BACKEND_CLASS": "oauth2_provider.backends.OAuthLibCore",
}

# When OAuth needs login, redirect to the frontend login page.
# After login the user has a Django session cookie (same domain via
# COOKIE_DOMAIN=.cytsoftware.com), so the OAuth authorize page works.
_frontend_url = _os.environ.get("FRONTEND_URL", "http://localhost:3000")
LOGIN_URL = f"{_frontend_url}/login"
