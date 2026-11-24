---
"@leejpsd/nextjs-cache-handler": patch
---

ISR handler: read all of an entry's tag states with one `MGET` instead of one `GET` per tag (#34). A page with five `_N_T_` layout tags now costs two Redis commands per `get()` instead of six; round trips were already one thanks to auto-pipelining, so this matters for per-command pricing and command-rate limits. On Redis Cluster, where the un-namespaced tag keys never share a slot, the handler keeps reading key by key: from the start when the client is the Cluster adapter (new `isCluster` flag on `RedisClientLike`) or `hashTag: true` is set, otherwise from the first `CROSSSLOT` reply on, retrying that read in place and logging one warning. `tag.expiration.read` is now also emitted by the ISR handler with `meta.strategy` (`"mget"` or `"per-key"`).
