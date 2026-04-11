---
id: poutine-26cc
title: 'BUG: Show ''Never scanned'' when Navidrome has no scan timestamp'
type: bug
priority: 3
created: '2026-04-11T05:42:06Z'
updated: '2026-04-11T05:42:06Z'
---

Until Navidrome is synced, Poutine shows 'Last Navidrome scan 739716d ago' because the timestamp is null/epoch and formatTimeAgo treats it as a very old date. Should display 'Never scanned' or similar when lastScan is null/missing.
