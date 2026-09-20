# ATRA runtime container.
#
# Multi-stage so the shipped image carries no test tooling and no frontend build
# chain. There is no native addon to compile either: the runtime uses Node's own
# node:sqlite, so no build toolchain appears in any stage.
#
# The dashboard is optional. `--build-arg WITH_FRONTEND=0` selects an empty
# asset stage, and BuildKit then skips the frontend build entirely — useful for
# a headless server or a CI smoke test that only exercises the API.

ARG NODE_VERSION=24-bookworm-slim
ARG WITH_FRONTEND=1

# ---------------------------------------------------------------------------
# Stage: build the dashboard (the repo root is the frontend project)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS frontend-1
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---------------------------------------------------------------------------
# Stage: no dashboard. An empty directory the final stage can still COPY from,
# so the two paths differ only in this one selector.
# ---------------------------------------------------------------------------
FROM busybox:stable AS frontend-0
RUN mkdir -p /build/dist

# Resolved from the build argument; the unselected stage is never built.
FROM frontend-${WITH_FRONTEND} AS frontend

# ---------------------------------------------------------------------------
# Stage: build the runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime-build
WORKDIR /build

RUN corepack enable

COPY runtime/package.json runtime/pnpm-lock.yaml runtime/pnpm-workspace.yaml runtime/.npmrc ./
RUN pnpm install --frozen-lockfile

COPY runtime/tsconfig.json runtime/tsconfig.build.json ./
COPY runtime/src ./src
RUN pnpm run build

# Migrations are plain .sql files, which tsc does not emit.
RUN cp -r src/db/migrations dist/db/migrations

# Reinstall production-only so devDependencies never reach the final image.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# Stage: the image that ships
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS final

ENV NODE_ENV=production \
    ATRA_DATA_DIR=/data \
    ATRA_STATIC_DIR=/app/public \
    ATRA_HOST=0.0.0.0 \
    ATRA_PORT=3000

WORKDIR /app

COPY --from=runtime-build /build/node_modules ./node_modules
COPY --from=runtime-build /build/dist ./dist
COPY --from=runtime-build /build/package.json ./package.json
COPY --from=frontend /build/dist ./public

# The data directory holds the encrypted vault and the database, and is the
# only thing the process may write to. Nothing under /app is writable.
RUN mkdir -p /data && chown -R node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

# node, not wget: the slim base image ships neither wget nor curl, and a health
# check that cannot run marks a perfectly healthy container unhealthy. Same
# command as docker-compose.yml, so the two cannot drift.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))"]

# Node is PID 1 and handles SIGTERM itself: the runtime locks the vault and
# checkpoints the database before exiting, so no init shim is needed.
CMD ["node", "dist/index.js"]
