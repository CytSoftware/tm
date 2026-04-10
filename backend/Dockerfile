FROM python:3.12-slim AS base

WORKDIR /app

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files first for better caching
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN uv sync --frozen --no-dev --no-install-project

# Copy application code
COPY . .

# Collect static files for admin
RUN uv run python manage.py collectstatic --noinput 2>/dev/null || true

EXPOSE 8000

# Run daphne (serves HTTP + WebSocket + MCP SSE from one process)
CMD ["uv", "run", "daphne", "-b", "0.0.0.0", "-p", "8000", "core.asgi:application"]
