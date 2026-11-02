---
"@leejpsd/nextjs-cache-handler": patch
---

Fix incremental `isTagStateExpired` so a future `expired` from `revalidateTag(tag, 'max')` no longer hard-misses every tagged entry for a year (#14). Add optional `preferRouteCacheKey` / `--prefer-route-cache-key` so seed writes App Router entries under `meta.routeCache.key` for Next.js 16.4+ Full Route Cache HITs.
