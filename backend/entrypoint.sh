#!/bin/sh
set -e

echo "Running migrations..."
uv run python manage.py migrate --noinput

# Create superuser from env vars if it doesn't exist yet
if [ -n "$DJANGO_SUPERUSER_USERNAME" ]; then
  uv run python manage.py createsuperuser \
    --noinput \
    --username "$DJANGO_SUPERUSER_USERNAME" \
    --email "${DJANGO_SUPERUSER_EMAIL:-admin@example.com}" \
    2>/dev/null || true
fi

# Auto-create the MCP OAuth application (idempotent)
echo "Ensuring MCP OAuth app exists..."
uv run python manage.py create_mcp_oauth_app 2>/dev/null || true

echo "Starting server..."
exec uv run daphne -b 0.0.0.0 -p 8000 core.asgi:application
