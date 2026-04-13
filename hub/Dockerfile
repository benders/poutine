FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install all dependencies (dev + prod) — needed for the build stage
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY hub/package.json hub/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile

# Install production dependencies only — native addons (argon2, better-sqlite3) compiled here
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
FROM node:22-slim AS runtime
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/hub/node_modules ./hub/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY hub/package.json hub/
COPY --from=build /app/hub/dist hub/dist/
COPY --from=build /app/frontend/dist hub/public/
RUN mkdir -p /app/data
ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/hub/public
# Tell the New Relic agent not to look for a newrelic.js config file;
# all configuration is supplied via environment variables.
ENV NEW_RELIC_NO_CONFIG_FILE=true
EXPOSE 3000
CMD ["node", "--import", "./hub/dist/newrelic-loader.js", "hub/dist/server.js"]
