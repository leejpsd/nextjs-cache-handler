---
"@leejpsd/nextjs-cache-handler": minor
---

Build-output cache seeding: `seedBuildOutput()` (new `/seed` entry point) and
`npx nextjs-cache-handler seed` walk `.next/` after a build and insert
prerendered App Router routes (including PPR segment data), Pages Router
routes, and fetch-cache entries into Redis in the handler's own record
format — with NX semantics so entries already written by live instances are
never overwritten. A fresh deployment's first requests are cache HITs
instead of a regeneration stampede (verified on a real Next 16 app: cold
server + seeded Redis → first request `x-nextjs-cache: HIT`). The
`RedisClientLike.set` contract gains an optional `NX` flag.
