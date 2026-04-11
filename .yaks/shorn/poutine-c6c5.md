---
id: poutine-c6c5
title: 'BUG: URL issues during page reload'
type: bug
priority: 1
created: '2026-04-11T00:40:19Z'
updated: '2026-04-11T03:02:52Z'
commit: 1282c13
---

Pages fail to load correctly on browser reload. Likely routing/SPA issue with nginx try_files or frontend router not handling direct URL access.
