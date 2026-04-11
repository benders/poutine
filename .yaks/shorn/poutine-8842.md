---
id: poutine-8842
title: 'BUG: getCoverArt/stream return 200 with JSON error body on failure'
type: bug
priority: 2
created: '2026-04-11T05:46:59Z'
updated: '2026-04-11T05:51:19Z'
commit: 1282c13
---

Binary endpoints (getCoverArt, stream) used sendSubsonicError which returns HTTP 200 with a JSON Subsonic envelope. Clients treat this as image/audio data and silently fail. Fixed: sendBinaryError returns real HTTP status codes (400/404/502) with a plain JSON error body.
