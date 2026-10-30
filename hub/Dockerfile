# Exact Node release, bumped by Dependabot (.github/dependabot.yml, #290). Keep both FROM lines identical.
FROM node:26.13.0-slim AS base
# Node 25+ no longer bundles corepack (#292). Keep in step with package.json packageManager.
RUN npm install -g pnpm@10.32.1
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install all dependencies (dev + prod) — needed for the build stage
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY hub/package.json hub/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile

# Install production dependencies only — better-sqlite3 native addon compiled here
FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY hub/package.json hub/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile --prod

# Build TypeScript (hub) and Vite (frontend)
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/hub/node_modules ./hub/node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY hub/ hub/
COPY frontend/ frontend/
RUN pnpm --filter hub build && cp -r hub/src/db/*.sql hub/dist/db/
RUN pnpm --filter frontend build

# Slim runtime — no build tools, copies pre-built native addons from prod-deps
FROM node:26.13.0-slim AS runtime
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/hub/node_modules ./hub/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY hub/package.json hub/
COPY --from=build /app/hub/dist hub/dist/
COPY --from=build /app/frontend/dist hub/public/
COPY hub/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /app/data
ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/hub/public
# Commit the image was built from, reported as `gitSha` by /api/health
# (issue #287). Declared last so a new SHA doesn't bust earlier layers.
ARG GIT_SHA=
ENV POUTINE_GIT_SHA=$GIT_SHA
EXPOSE 3000
# Entrypoint enables the New Relic agent when NEW_RELIC_LICENSE_KEY is set;
# otherwise it execs plain `node hub/dist/server.js`.
CMD ["/app/docker-entrypoint.sh"]
