---
"@leejpsd/nextjs-cache-handler": minor
---

Opt-in push-based tag propagation (`tagPubSub: true`, plural handler):
`updateTags()` publishes invalidations on a namespaced channel and every
instance maintains a subscription on a dedicated duplicate connection,
updating its local tag mirror in ~3 ms (measured cross-instance over real
Redis with both redis@5 and ioredis) instead of waiting for the next
`refreshTags()` scan (~seconds). The scan keeps running as the consistency
safety net, so a dropped subscription degrades to the previous behavior —
never to staleness. Cluster clients fall back to polling with a one-time
warning. `RedisClientLike` gains optional `publish`/`subscribe`.
