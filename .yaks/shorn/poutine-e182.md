---
id: poutine-e182
title: Single host:port for frontend + hub
type: feature
priority: 2
created: '2026-04-11T04:29:13Z'
updated: '2026-04-11T06:08:39Z'
commit: 3b7ea65
---

Currently frontend (nginx, port 8080) and hub (port 3000) are separate. Expose a single host:port that serves both — frontend static assets and all API routes — to simplify deployment and peering config.

## Plan: Hub serves static files (Option A)

Hub becomes the single process. No nginx container. Federation peer URLs == user-facing URL — no split to reason about.

### Steps

1. Add @fastify/static to hub — serve frontend/dist/ at /. Existing routes (/admin/, /rest/, /federation/, /api/) registered first so they take priority. SPA fallback: 404 handler returns index.html.

2. Build frontend inside hub Dockerfile — add build stage that runs pnpm --filter frontend build, copy frontend/dist/ into hub runtime image (e.g. hub/public/).

3. Config: optional PUBLIC_DIR env var pointing to static dir. Dev: unset (no static serving, use Vite dev server). Prod: set to ./public.

4. docker-compose: remove frontend service entirely. Hub publishes one port (rename HUB_HOST_PORT -> POUTINE_HOST_PORT or similar).

5. local-cluster / federation test: remove frontend containers from scripts. Peer URLs stay as hub URLs (already the case for federation tests).

6. Vite dev proxy: vite.config.ts already proxies /admin, /rest, etc. to localhost:3000. No change needed for dev.
