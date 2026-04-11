---
id: poutine-043a
title: 'BUG: getCoverArt returning 401 Authentication required'
type: bug
priority: 1
created: '2026-04-11T05:52:09Z'
updated: '2026-04-11T06:07:30Z'
commit: 38eab5e
---

After switching getCoverArt to requireSubsonicAuthBinary, cover art requests are returning 401 Authentication required. The frontend passes JWT via token query param (artUrl) — investigate whether extractJwt is correctly reading it in the binary auth middleware.
