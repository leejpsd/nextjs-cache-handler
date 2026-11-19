---
"@leejpsd/nextjs-cache-handler": minor
---

New `tagReadMode` option for the `'use cache'` handler (#31). The default, `"scan"`, is unchanged: `refreshTags()` SCANs the namespace's tag markers into a local mirror on every request. Redis SCAN walks the whole keyspace regardless of the MATCH pattern, so that cost grows with the total number of keys in the database, not with the number of tags: about 20 ms per request at 20k keys and 65–170 ms at 100k against a local Redis. `tagReadMode: "on-demand"` turns the scan off; `get()` and `getExpiration()` instead `MGET` the markers for exactly the tags they are given (the entry's own tags plus the route's soft tags), one extra round trip per `get()`, which is how the singular handler and `getExpiration()` already worked. `tagPubSub` works in either mode. Thanks @royvou for the report and the proposal.
