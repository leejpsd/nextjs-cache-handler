---
"@leejpsd/nextjs-cache-handler": patch
---

Fix incremental `isTagStateExpired` so a future `expired` from `revalidateTag(tag, 'max')` no longer hard-misses every tagged entry for a year (#14).
