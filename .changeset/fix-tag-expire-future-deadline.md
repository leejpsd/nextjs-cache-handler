---
"@leejpsd/nextjs-cache-handler": patch
---

Fix incremental `isTagStateExpired` so a future `expired` from `revalidateTag(tag, 'max')` no longer hard-misses every tagged entry for a year (#14). Hard invalidations (`updateTag`, single-argument `revalidateTag`) still apply the moment they are read, even on an instance whose clock is behind the one that wrote them.
