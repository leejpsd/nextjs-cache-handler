---
"@leejpsd/nextjs-cache-handler": patch
---

`cacheHandler` (singular): `revalidateTag` no longer resolves when the tag state could not be written because there is no Redis connection (failed initialization or the reconnect cooldown). It previously returned normally and emitted a `tag.invalidate.*` metric with `backend: "redis"`, so a caller could not tell an unwritten invalidation from a confirmed one while other instances kept serving the old entry (#13). It now rejects, exactly as it already did when the write itself failed or timed out, and no success metric is emitted. The invalidation is still applied in the calling process first. Memory-only modes (`fallback: "always"`, build phase, `instance-local:` tags) are unchanged.
