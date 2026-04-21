#!/usr/bin/env bash
# Dev runner for the backend. Reads ``backend/.env`` (also loaded by
# settings.py) so CORS/CSRF/FRONTEND_URL and the listen port stay in sync.
# Pass ``--port <N>`` to override DJANGO_PORT for a one-off run.
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

PORT="${DJANGO_PORT:-8000}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

exec uv run daphne -b 0.0.0.0 -p "$PORT" core.asgi:application
