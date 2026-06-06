# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# @zekktris/api production image
# Build context: monorepo root (because we install via pnpm workspaces).
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install pnpm and resolve dependencies ──────────────────────────
# This stage is cached aggressively: invalidated only when package.json or
# pnpm-lock.yaml changes. Source-only edits won't bust this cache.
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /app

# Copy lockfile + workspace manifest first so layer caching works.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./

# Copy every workspace package.json (deps step needs them but not the source).
# Listing these explicitly is tedious but it's what gives us the caching.
COPY apps/api/package.json        apps/api/
COPY packages/db/package.json     packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/

# Tell pnpm not to update the lockfile in any case (CI hygiene). We install
# devDependencies too because tsx is in deps but typescript / @types/* are
# devDeps and the running code references them transitively.
RUN pnpm install --frozen-lockfile --filter "@zekktris/api..."

# ── Stage 2: runtime ────────────────────────────────────────────────────────
# Same Alpine base — keeps the final image small. We copy the resolved
# node_modules from `deps`, then layer the source on top.
FROM node:20-alpine AS runtime
RUN corepack enable && apk add --no-cache tini
WORKDIR /app

# Defaults the operator can override.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=deps /app/node_modules                 /app/node_modules
COPY --from=deps /app/apps/api/node_modules        /app/apps/api/node_modules
COPY --from=deps /app/packages/db/node_modules     /app/packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules /app/packages/shared/node_modules

# Source. Note: we don't ship the lockfile/workspace files into the image
# (the resolved node_modules graph is enough for runtime).
COPY apps/api          /app/apps/api
COPY packages/db       /app/packages/db
COPY packages/shared   /app/packages/shared
COPY packages/tsconfig /app/packages/tsconfig
COPY package.json pnpm-workspace.yaml /app/

EXPOSE 3000

# Drop root. The official node image has a `node` user we can use directly,
# and the tsx runtime doesn't need any special privileges.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node

WORKDIR /app/apps/api

# tini handles PID-1 signal forwarding so SIGTERM from `docker stop` reaches
# our shutdown hook in index.ts (server.close + gateway.detachAll).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
