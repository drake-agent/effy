# ═══════════════════════════════════════════════════════════════
# Effy v3.6.2 — ECS Fargate Docker Build
# Stage 1: Install deps (with native build tools for better-sqlite3)
# Stage 2: Production image (minimal)
# ═══════════════════════════════════════════════════════════════

# ── Stage 1: Builder ──
FROM node:22 AS builder

WORKDIR /app

# Install dependencies (node:22 full image has python3, make, g++ pre-installed)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Production ──
FROM node:22-slim AS production

LABEL org.opencontainers.image.title="Effy"
LABEL org.opencontainers.image.description="Native Gateway Multi-Agent Platform"
LABEL org.opencontainers.image.version="3.6.2"

WORKDIR /app

# Copy only what's needed
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY agents/ ./agents/
COPY config/ ./config/
COPY effy.config.yaml ./
COPY package.json ./
COPY teams-app/ ./teams-app/

# Create data directory and non-root user
RUN mkdir -p data && \
    groupadd -r effy && \
    useradd -r -g effy -d /app effy && \
    chown -R effy:effy /app

USER effy

# ECS uses ALB health check, not Docker HEALTHCHECK
EXPOSE 3000

CMD ["node", "src/app.js"]
