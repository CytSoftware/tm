FROM python:3.14-slim AS base

WORKDIR /app

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files first for better layer caching
COPY pyproject.toml uv.lock ./

# Install dependencies (frozen = exact lockfile versions)
RUN uv sync --frozen --no-dev

# Copy application code
COPY . .

# Run migrations and collect static files at build time
RUN uv run python manage.py collectstatic --noinput 2>/dev/null || true

EXPOSE 8000

# Daphne serves HTTP + WebSocket + MCP SSE from one process
CMD ["uv", "run", "daphne", "-b", "0.0.0.0", "-p", "8000", "core.asgi:application"]
