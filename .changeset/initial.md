---
"@leejpsd/nextjs-cache-handler": minor
---

Initial pre-release. Implements both Next.js 16 cache handler interfaces
(`cacheHandler` singular for ISR/Pages Router and `cacheHandlers` plural
for the `'use cache'` directive / `cacheComponents: true`).

Highlights:

- Build-phase skip via `NEXT_PHASE=phase-production-build` detection (the
  fix that left `@fortedigital/nextjs-cache-handler` PR #207 stalled)
- Automatic per-deployment isolation via `BUILD_NAMESPACE`
  (`DEPLOYMENT_VERSION` / `GIT_HASH`)
- Lua-atomic SET-with-tags and revalidate-hard scripts
- 3-axis SWR partition (fresh / stale / expired) with clock-skew handling
- AbortSignal timeout (default 1500ms) on all Redis calls
- TTL-aware in-memory fallback (32-bit timer clamp included)
- ESM + CJS dual publish, full TypeScript types
- 66 unit tests, 7 entry-point types check (attw 100% green)
