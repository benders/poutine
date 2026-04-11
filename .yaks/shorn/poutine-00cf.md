---
id: poutine-00cf
title: 'BUG: Authentication expires leaving UI in broken state'
type: bug
priority: 1
created: '2026-04-11T00:40:19Z'
updated: '2026-04-11T02:29:24Z'
commit: f9579b1
---

When JWT expires, UI enters broken state instead of redirecting to login. Need to handle 401 responses gracefully — redirect or prompt re-auth.
