# ═══════════════════════════════════════════════════════════════
# Effy v3.9.0 — Multi-stage Docker Build
# Stage 1: Install deps (with native build tools for better-sqlite3)
# Stage 2: Production image (minimal)
# ═══════════════════════════════════════════════════════════════

# ── Stage 1: Builder ──
FROM node:24-slim AS builder

WORKDIR /app

# System deps for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production --ignore-scripts=false

# ── Stage 2: Production ──
FROM node:24-slim AS production

LABEL org.opencontainers.image.title="Effy"
LABEL org.opencontainers.image.description="Native Gateway Multi-Agent Platform"
LABEL org.opencontainers.image.version="3.9.0"

WORKDIR /app

# Copy only what's needed
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY agents/ ./agents/
COPY config/ ./config/
COPY effy.config.yaml ./
COPY package.json ./

# Create data directory and non-root user
RUN mkdir -p data && \
    groupadd -r effy && \
    useradd -r -g effy -d /app effy && \
    chown -R effy:effy /app

USER effy

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3100/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3100 3978

CMD ["node", "src/app.js"]
