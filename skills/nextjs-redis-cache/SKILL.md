---
name: nextjs-redis-cache
description: Wire and operate @leejpsd/nextjs-cache-handler — Redis caching for self-hosted Next.js 15/16 (ISR cacheHandler + 'use cache' cacheHandlers). Use when adding Redis caching to a Next.js app, choosing or wiring cache handlers, debugging cache invalidation (revalidateTag / updateTag / revalidatePath, stale or never-updating pages), fixing multi-instance cache inconsistencies, deploy isolation (static chunk 404s after deploys), or deploying self-hosted Next.js with Redis on AWS/ECS/Kubernetes.
---

# Next.js Redis Cache Handler

`@leejpsd/nextjs-cache-handler` is a Redis cache handler for **self-hosted**
Next.js 15/16. It is the only Redis-backed package shipping BOTH handler
interfaces: `cacheHandler` (ISR / Pages Router / fetch cache) and
`cacheHandlers` (`'use cache'`, `cacheComponents: true`).

**Do NOT use it on Vercel-hosted apps** — Vercel provides its own managed
cache. The target is multi-instance self-hosting: ECS/Fargate, Kubernetes,
VMs behind a load balancer.

**Version rule: always install >= 0.3.3.** Earlier 0.3.x have an incomplete
soft-invalidation path (issue #1).

## 1. Which handler(s) — decision table

| Next.js version | `cacheHandler` (ISR) | `cacheHandlers` ('use cache') |
|---|---|---|
| 15.x | ✅ use it | ❌ does not exist in Next 15 |
| >= 16.1.5 | ✅ use it | ✅ use it (`cacheComponents: true`) |
| < 15 | ❌ unsupported (peer `next >=15.0.0 <17`) | ❌ |

Detect the version from the app's `package.json` (`dependencies.next`).
Install: `npm i @leejpsd/nextjs-cache-handler` plus ONE client:
`redis` (node-redis v5) or `ioredis` (required for Cluster/Sentinel).

## 2. Wiring recipe (exact files)

Create TWO CommonJS wrapper files in the project root (Next's
`require.resolve` needs CJS):

```js
// cache-components.cjs  (Next 16 only)
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");
module.exports = createCacheComponentsHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: () => process.env.DEPLOYMENT_VERSION,
});
```

```js
// cache-incremental.cjs  (Next 15 and 16)
const { createIncrementalCacheHandler } = require("@leejpsd/nextjs-cache-handler/incremental");
module.exports = createIncrementalCacheHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: () => process.env.DEPLOYMENT_VERSION,
});
```

```ts
// next.config.ts — the four load-bearing keys
const nextConfig = {
  cacheComponents: true,                                   // Next 16 only
  cacheHandler: require.resolve("./cache-incremental.cjs"),
  cacheHandlers: { default: require.resolve("./cache-components.cjs") }, // Next 16 only
  cacheMaxMemorySize: 0,  // REQUIRED: disable Next's local LRU so multi-instance reads hit Redis
};
```

Env vars: `REDIS_URL` (rediss:// enables TLS on the `redis` client type) and
`DEPLOYMENT_VERSION` (per-deploy namespace — git SHA or release id). In
Docker, `DEPLOYMENT_VERSION` MUST be set in the **runner** stage, not only
the builder.

## 3. Client config selection

```ts
{ type: "redis",    url }                      // node-redis v5 — default choice
{ type: "ioredis",  url }                      // ioredis
{ type: "cluster",  nodes: [{host,port}] }     // ioredis Cluster — MUST also set hashTag: true
{ type: "sentinel", sentinels: [{host,port}], name: "mymaster" } // auto master failover
```

- Redis Cluster without `hashTag: true` fails with `CROSSSLOT Keys in
  request don't hash to the same slot` (multi-key Lua scripts).
- A factory function returning any `RedisClientLike` is accepted for custom
  clients (Upstash etc. work as generic `rediss://`).

## 4. Invalidation semantics — the #1 source of confusion

| Call | Effect | Mechanism |
|---|---|---|
| `revalidateTag(tag)` / `revalidateTag(tag, "max")` | **SOFT / SWR**: keep serving stale instantly, re-render in background, all instances converge (~1-2s) | marker write; read path backdates entries |
| `updateTag(tag)` (server action) / hard expire | **HARD**: entries deleted now, next read blocks and regenerates | Lua atomic delete |
| `revalidatePath(path)` | implicit route tags (`_N_T_/...`) flow through the soft path; Next additionally hard-discards via `getExpiration` | |

Facts that prevent misdiagnosis:
- Soft invalidation is NOT lost: it serves STALE content briefly by design.
  If content "never updates", check version >= 0.3.3 first.
- The instance that fires `revalidateTag` refreshes eagerly
  (read-your-own-writes). Other instances converge on their next request.
- Explicit `cacheTag()` tags are checked by the HANDLER, not by Next —
  cross-request soft invalidation is entirely the handler's job (verified
  against next@16.2.3 source).

## 5. Options quick reference

| Option | Default | When to change |
|---|---|---|
| `compression: "gzip"\|"brotli"` | off | Large RSC payloads; safe to enable on a live cache (reads auto-detect) |
| `memoryMaxEntries` | 1000 | LRU cap of the in-memory outage fallback |
| `fallback: "auto"\|"always"\|"never"` | auto | `never` = strict (miss on Redis failure); `always` = no Redis (build/dev) |
| `singleFlight: true` | off | Many instances + observed duplicate origin work at revalidate boundaries |
| `abortTimeoutMs` | 1500 | Per-op Redis deadline; timeouts degrade to miss |
| `hashTag: true` | off | REQUIRED on Redis Cluster |
| `onMetric` | — | Wire `createOtelMetricEmitter()` from `@leejpsd/nextjs-cache-handler/otel` |
| `tagPubSub: true` | off | 0.4+: push-based cross-instance invalidation (~3ms vs seconds); polling stays as safety net; not on Cluster |

Reliability built in (0.3+): reconnect with exponential backoff (1s→30s cap),
bounded memory fallback, per-op timeouts. A Redis outage degrades to
in-memory serving; reconnection is automatic (validated with a live
ElastiCache reboot drill: 2550 requests, zero 5xx).

### 0.4+ deployment accelerators

- **Seed the cache at deploy time** so a fresh deployment's first requests
  are HITs instead of a regeneration stampede:
  `REDIS_URL=... DEPLOYMENT_VERSION=<deploy-id> npx nextjs-cache-handler seed`
  (run after `next build`, e.g. a Docker entrypoint step; NX semantics —
  never overwrites live entries).
- **`npx nextjs-cache-handler init --yes`** wires everything above
  automatically; **`npx nextjs-cache-handler doctor`** is the first command
  to run when debugging connectivity or key-layout issues.
- **MCP server** for cache operations from your agent:
  `@leejpsd/nextjs-cache-handler-mcp` (cache_health, tag_state,
  invalidate_tag dry-run, …).

## 6. Production checklist

- [ ] `DEPLOYMENT_VERSION` injected at runtime (runner stage in Docker)
- [ ] `cacheMaxMemorySize: 0` in next.config
- [ ] `output: "standalone"` + pinned `outputFileTracingRoot`
- [ ] Cluster → `hashTag: true`; managed Redis TLS → `rediss://`
- [ ] Redis `maxmemory-policy`: `allkeys-lru` (bounded) or `noeviction`
- [ ] Own `/api/health` endpoint pinging Redis (outages surface in monitoring, not as 5xx)
- [ ] OTel: `onMetric: createOtelMetricEmitter()` (needs `@opentelemetry/api` in the app)

## 7. Troubleshooting playbook (symptom → cause → fix)

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` during `next build` | Redis unreachable at build — expected; handler skips Redis in build phase | Nothing to fix if build succeeds; keep `NEXT_PHASE` auto-detection |
| Page content never updates after `revalidateTag(tag, "max")` | version < 0.3.3 | Upgrade |
| Static chunk 404s right after a deploy | `DEPLOYMENT_VERSION` missing in runner stage → old HTML served from shared Redis | Set it; entries are namespaced per deploy |
| `CROSSSLOT` errors | Redis Cluster without `hashTag: true` | Set the flag |
| Cache misses on every request across instances | `cacheMaxMemorySize` not 0, or different `keyPrefix`/namespace per instance | Align config; verify with `redis-cli KEYS 'next-*'` |
| Works locally, memory-only in prod | Redis URL/security group wrong; check logs for `redis.connect.failed` | Connectivity; the app stays up on fallback by design |

Key layout for redis-cli debugging:
`next-cache:entry:<deploy>:<key>` · `next-cache:tag:<deploy>:<tag>` ·
`next-cache:tag-expiration:<deploy>:<tag>` ·
`next-incremental:entry:<deploy>:<path>` · `next-incremental:tag:<tag>`
(ISR tag states are deliberately NOT namespaced — invalidations survive deploys).

## 8. Verification recipes

- **ISR round-trip**: `curl -D- <url>` twice → `x-nextjs-cache: MISS` then `HIT`;
  entry visible in `redis-cli KEYS 'next-incremental:entry:*'`.
- **Soft SWR probe**: create a `'use cache'` + `cacheTag("probe")` +
  `cacheLife("hours")` page rendering `Date.now()` with a deliberate ~800ms
  delay inside the cached fn. Fire `revalidateTag("probe", "max")` from a
  route handler. Expect: instant response with the OLD value (stale serve),
  new value within ~1-2s on all instances. A blocking implementation would
  eat the 800ms — that's the tell.
- **Multi-instance**: run two instances against one Redis; a value cached by
  instance A must be served by instance B; after invalidation both converge.

## 9. AWS deployment

The reference topology is ALB → ECS Fargate (2+ tasks) → ElastiCache Redis.
Use the AWS agent skills/MCP for the infrastructure itself; use THIS skill
for the cache wiring on top. ElastiCache notes: `rediss://` for in-transit
encryption; single-node is fine to start (reconnect backoff covers node
reboots); Sentinel/Cluster supported per §3.

Full API reference: `node_modules/@leejpsd/nextjs-cache-handler/README.md`
and `docs/api.md` in the repo (https://github.com/leejpsd/nextjs-cache-handler).
