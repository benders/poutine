FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY hub/package.json hub/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/hub/node_modules ./hub/node_modules
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY hub/ hub/
COPY frontend/package.json frontend/
RUN pnpm --filter hub build && cp -r hub/src/db/*.sql hub/dist/db/

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/hub/package.json hub/
COPY --from=build /app/frontend/package.json frontend/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/hub/dist hub/dist/
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "hub/dist/server.js"]
