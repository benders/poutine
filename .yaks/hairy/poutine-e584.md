---
id: poutine-e584
title: 'BUG: local-run.sh hub-a fails to join docker bridge network'
type: bug
priority: 3
created: '2026-04-11T02:37:47Z'
updated: '2026-04-11T06:09:54Z'
---

local-run.sh line 80 runs:
  docker network connect --alias hub-a poutine-local-cluster cd-rips-hub-1

This fails intermittently or consistently — hub-a never gets the
hub-a DNS alias on the poutine-local-cluster bridge, so hub-b and
hub-c can't reach it via http://hub-a:3000.

## Likely causes to investigate

1. Container name mismatch: script assumes `cd-rips-hub-1` but
   Docker Compose version may produce a different name (e.g.,
   `cd-rips-hub-1` vs `cd-rips_hub_1`). Verify with:
     docker ps --format '{{.Names}}' | grep cd-rips

2. Race condition: `up -d --build --force-recreate hub navidrome`
   returns before container is fully named/running. The network
   connect immediately follows with no readiness check.

3. Script uses `set -euo pipefail` — if network connect silently
   produces a non-zero exit, script aborts and cleanup tears
   everything down. Check whether connect actually errors or
   succeeds but alias doesn't work.

4. Network already exists from a prior run: `docker network create`
   fails if network exists. The prior `docker network rm || true`
   might not have fully cleaned up (e.g., containers still
   attached). Verify with: docker network inspect poutine-local-cluster

## Context

- Script: local-cluster/local-run.sh
- Peers config: local-cluster/local-peers.yaml — hub-b and hub-c
  peer URLs are http://hub-a:3000 (DNS alias, not IP)
- Three Compose projects: cd-rips (hub-a/3001), digital-purchases
  (hub-b/3002), other (hub-c/3003)
- Same pattern works in test/federation/run.sh (ports 3011-3013)
  — compare that script for fixes that may not have been ported
