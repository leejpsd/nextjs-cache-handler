# @leejpsd/nextjs-cache-handler

[![npm](https://img.shields.io/npm/v/@leejpsd/nextjs-cache-handler.svg)](https://www.npmjs.com/package/@leejpsd/nextjs-cache-handler)
[![license](https://img.shields.io/npm/l/@leejpsd/nextjs-cache-handler.svg)](./LICENSE)

> **`v0.4.2`** — install with
> `npm install @leejpsd/nextjs-cache-handler`, or wire everything with
> `npx nextjs-cache-handler init --yes`. Production-validated against
> AWS ECS Fargate with multi-instance Redis (24h live-traffic soak and a
> live Redis-reboot drill with zero 5xx — see
> [`docs/staging-verification-2026-08-01.md`](./docs/staging-verification-2026-08-01.md)),
> and exercised end-to-end against **Next.js 16.3** (both cache interfaces).
>
> v0.4 adds: **build-output cache seeding** (first request after deploy is a
> HIT), **pub/sub tag propagation** (~3ms cross-instance), **Redis Cluster**
> e2e in CI, a **CLI** (`init` / `doctor` / `seed`), and agent-native assets
> (skill, rules, [MCP server](https://www.npmjs.com/package/@leejpsd/nextjs-cache-handler-mcp)).
> 0.4.2 aligns tag invalidation exactly with upstream semantics
> (`updateTag()` hard vs `revalidateTag(tag, "max")` soft — see CHANGELOG).

## 🤖 For AI agents

Working with Claude Code / Codex / Cursor? Give your agent this URL and it
will install and wire everything (version detection, wrapper files,
next.config patch, verification):

```
https://raw.githubusercontent.com/leejpsd/nextjs-cache-handler/main/setup-instructions/setup.md
```

An agent skill with decision tables, invalidation semantics, and a
troubleshooting playbook ships in the package (`AGENTS.md`,
`skills/nextjs-redis-cache/SKILL.md`) and via
`npx skills add leejpsd/nextjs-cache-handler`.

For cache operations from your agent (health, tag state, safe invalidation),
the companion MCP server is on the official registry as
`io.github.leejpsd/nextjs-cache-handler-mcp` — or one command:
`npx nextjs-cache-handler init --yes` wires handlers, rules, and `.mcp.json` together.

---

The Redis cache handler for **Next.js 15/16** that ships **both** `cacheHandler`
(ISR / Pages Router) **and** `cacheHandlers` (`'use cache'` directive,
`cacheComponents: true`) — the area where
[`@fortedigital/nextjs-cache-handler`](https://github.com/fortedigital/nextjs-cache-handler)
currently lists "Help needed".

```ts
// next.config.ts
const nextConfig = {
  cacheComponents: true,
  cacheHandler: require.resolve("./cache-incremental.cjs"),
  cacheHandlers: { default: require.resolve("./cache-components.cjs") },
};
```

```js
// cache-components.cjs
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");
module.exports = createCacheComponentsHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: process.env.DEPLOYMENT_VERSION, // auto-isolates deploys
});
```

That's it. `'use cache'`, `revalidateTag`, `updateTag`, `cacheLife` all work.

---

## Why this exists

Next.js 16 split caching into two handler interfaces:

| Option | Used by | Methods |
|---|---|---|
| `cacheHandler` (singular) | Pages Router ISR, on-demand revalidation | `get`, `set`, `revalidateTag`, `resetRequestCache` |
| `cacheHandlers` (plural) | `'use cache'` directive, `cacheComponents: true` | `get`, `set`, `refreshTags`, `getExpiration`, `updateTags` |

As of 2026-05, the leading OSS Redis handler `@fortedigital/nextjs-cache-handler@3.2.0`
declares `peerDependencies.next: ">=16.1.5"` but the README marks the new
plural interface as ❌ **"Not yet supported - Help needed"**:

> 📅 **Compatibility matrix re-verified 2026-07-31** (from each project's
> published README/registry metadata). The OSS Next.js cache
> handler ecosystem moves quickly — please verify
> [`@fortedigital`](https://github.com/fortedigital/nextjs-cache-handler#compatibility)
> and
> [`nextjs-turbo-redis-cache`](https://github.com/trieb-work/nextjs-turbo-redis-cache#features)
> directly before relying on this comparison.

| Feature | this (0.4.x) | @fortedigital 3.2.1 | nextjs-turbo-redis-cache 1.15 |
|---|---|---|---|
| `cacheHandlers` config (plural) | ✅ | ❌ Help needed | ✅ since 1.11 |
| `'use cache'` directive | ✅ | ❌ Help needed | ✅ since 1.11 |
| `'use cache: remote'` | ✅ default handler (dedicated multi-tier: roadmap) | ❌ Help needed | partial |
| `'use cache: private'` | n/a (uncustomizable) | n/a | n/a |
| `cacheComponents: true` | ✅ | ❌ Help needed | ✅ |
| Build-phase skip (`PHASE_PRODUCTION_BUILD`) | ✅ | ✅ (singular only) | ✅ |
| Auto deploy isolation | ✅ `BUILD_NAMESPACE` env-resolved | manual | ✅ `BUILD_ID` since 1.13 |
| Lua-atomic SET+tag | ✅ Lua scripts | partial (MULTI) | partial |
| AbortSignal timeout | ✅ per-op | ✅ Proxy-wrapped | ❌ |
| Redis Cluster | ✅ (cluster adapter, see Production checklist) | ✅ | ✅ |
| ioredis support | ✅ | ✅ | ✅ |
| In-memory fallback (TTL-aware) | ✅ | partial | ✅ L1 + Redis L2 |
| Next 15 support (ISR handler) | ✅ `>=15.0.0` | ✅ (legacy 2.x line) | ✅ `>=15.0.3` |
| Request-scoped GET dedup | ✅ | ❌ | ✅ |
| Built-in value compression | ✅ gzip/brotli option | example only | example only |
| Redis Sentinel | ✅ (local failover drill) | ❌ | ❌ |
| OpenTelemetry | ✅ built-in `/otel` emitter + `onMetric` hook | ❌ | ❌ |
| Reconnect strategy | ✅ exponential backoff | client-level | error-threshold restart |
| Live-traffic dogfood (24h+) | ✅ AWS ECS Fargate | not published | not published |

PR [#207](https://github.com/fortedigital/nextjs-cache-handler/pull/207) on
`@fortedigital` (their `cacheHandlers` attempt) was held up in review over
`PHASE_PRODUCTION_BUILD` handling — which this package has from the start.

---

## Quick start

### Install

```bash
npm install @leejpsd/nextjs-cache-handler redis
# or
npm install @leejpsd/nextjs-cache-handler ioredis
```

`redis` and `ioredis` are optional peer dependencies — install whichever
client you use. Both can be present.

### Wire up

Two CommonJS wrapper files in your project root (Next.js's
`require.resolve` pattern doesn't accept ESM directly):

```js
// cache-components.cjs
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");
module.exports = createCacheComponentsHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: process.env.DEPLOYMENT_VERSION,
  abortTimeoutMs: 1500,
});
```

```js
// cache-incremental.cjs
const { createIncrementalCacheHandler } = require("@leejpsd/nextjs-cache-handler/incremental");
module.exports = createIncrementalCacheHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: process.env.DEPLOYMENT_VERSION,
  abortTimeoutMs: 1500,
});
```

```ts
// next.config.ts
import path from "path";
import type { NextConfig } from "next";

const enabled = !!process.env.REDIS_URL && process.env.DISABLE_REDIS_CACHE_HANDLER !== "true";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  cacheComponents: true,
  deploymentId: process.env.DEPLOYMENT_VERSION,
  generateBuildId: async () => process.env.DEPLOYMENT_VERSION ?? "dev-build",
  cacheMaxMemorySize: 0, // delegate everything to the Redis handler
  cacheHandler: enabled ? require.resolve("./cache-incremental.cjs") : undefined,
  cacheHandlers: enabled ? { default: require.resolve("./cache-components.cjs") } : {},
};
export default nextConfig;
```

### Use in your code

```tsx
// app/blog/page.tsx
import { cacheLife, cacheTag, revalidateTag } from "next/cache";

async function getPosts() {
  "use cache";
  cacheLife("hours");
  cacheTag("posts");
  return await db.post.findMany();
}

// Server Action — invalidate
async function publishPost(formData: FormData) {
  "use server";
  await db.post.create({ data: Object.fromEntries(formData) });
  revalidateTag("posts", "max");
}

export default async function Page() {
  const posts = await getPosts();
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

---

## Configuration reference

```ts
interface CacheHandlerOptions {
  client: RedisClientFactory | RedisClientConfig;
  keyPrefix?: string;             // default: "next-cache:" / "next-incremental:"
  buildNamespace?: string | (() => string);  // default: env DEPLOYMENT_VERSION || GIT_HASH || "unversioned"
  abortTimeoutMs?: number;        // default: 1500
  fallback?: "auto" | "always" | "never";    // default: "auto"
  staleWhileRevalidate?: boolean; // default: true (cache-components only)
  singleFlight?: boolean;         // default: false — see "Single-flight refresh lock" below
  singleFlightLockTtlSec?: number; // default: 10
  isBuildPhase?: () => boolean;   // override PHASE_PRODUCTION_BUILD detection
  hashTag?: boolean;              // default: false (set true on Redis Cluster)
  memoryMaxEntries?: number;      // default: 1000 — LRU cap for the in-memory fallback
  compression?: "gzip" | "brotli"; // default: off — transparent value compression (node:zlib)
  onMetric?: (event: MetricEvent) => void;
  logger?: Logger;
}

type RedisClientConfig =
  | { type: "redis";    url: string; password?: string; tls?: boolean; connectTimeout?: number }
  | { type: "ioredis";  url: string; password?: string; tls?: boolean; connectTimeout?: number }
  | { type: "cluster";  nodes: { host: string; port: number }[]; password?: string; tls?: boolean }
  | { type: "sentinel"; sentinels: { host: string; port: number }[]; name: string;
      password?: string; sentinelPassword?: string; tls?: boolean; connectTimeout?: number };
```

Full reference: [`docs/api.md`](./docs/api.md).

---

## Production checklist

- [ ] **`DEPLOYMENT_VERSION` env injected at runtime** — every entry key is
      prefixed with this so old prerender HTML can't bleed across deploys.
      For Docker, set `ENV DEPLOYMENT_VERSION=...` in your **runner** stage,
      not just the builder. (See [`docs/build-phase.md`](./docs/build-phase.md).)
- [ ] **`cacheMaxMemorySize: 0`** — turn off Next's local LRU so multi-instance
      reads always hit Redis (or the explicit memory fallback).
- [ ] **`outputFileTracingRoot` pinned** — required for `output: "standalone"`
      to avoid static-chunk-404 issues during a deploy.
- [ ] **`abortTimeoutMs: 1500`** (default) — protects against a stuck Redis
      connection from hanging the request thread.
- [ ] **Redis Cluster: set `hashTag: true`** — multi-key Lua scripts
      (`set-with-tags.lua`, `revalidate-hard.lua`) require all KEYS to land
      on the same hash slot. Without `hashTag`, cluster deployments will hit
      `CROSSSLOT Keys in request don't hash to the same slot`. The flag wraps
      the namespace in `{}` so every key for a given deploy hashes together.
      Cluster support is validated by a dedicated e2e suite against a real
      3-master cluster (`npm run test:cluster`, also in CI) — covering the
      multi-key Lua scripts, per-master SCAN propagation, and both handlers.
      Not yet load-tested at production scale.
- [ ] **Redis `maxmemory-policy: allkeys-lru` or `noeviction`** — if you need
      bounded memory, choose `allkeys-lru`. Otherwise `noeviction` keeps
      tag indices intact.
- [ ] **TLS** — use `rediss://` URLs (e.g. ElastiCache in-transit
      encryption). The library auto-detects from the URL scheme.
- [ ] **Health check** — call your own `/api/health` that pings Redis
      (separate from the handler) so a Redis outage surfaces in your
      monitoring without inducing 5xx in user requests.

### Compatibility with Redis-protocol services

| Service | How to use | Tested? |
|---|---|---|
| **Self-hosted Redis 7+** | `{ type: "redis", url }` or `{ type: "ioredis", url }` | ✅ AWS ElastiCache 24h soak |
| **Redis Cluster** | `{ type: "cluster", nodes }` + `hashTag: true` | ✅ e2e-tested against a real 3-master cluster (CI); not yet load-tested at scale |
| **Upstash Redis** | `{ type: "redis", url: "rediss://..." }` (TLS auto-detected) | not yet validated, expected to work via the standard Redis protocol |
| **AWS ElastiCache (replication group)** | `{ type: "redis", url: "rediss://..." }` | ✅ reference deployment (re-verified 2026-08-01, Seoul) |
| **Redis Sentinel** | `{ type: "sentinel", sentinels, name }` | ✅ local master/replica failover drill |
| **Vercel KV** | not yet supported — dedicated adapter on the roadmap | — |
| **DragonflyDB / KeyDB** | Redis-protocol compatible — `{ type: "redis", url }` should work | not validated |

---

## Single-flight refresh lock (v0.2)

The `cacheHandlers` (plural) interface returns stale entries inside the
SWR window so users get an instant response while the background
refresh completes. With many instances, the moment an entry crosses the
`revalidate` boundary, every instance independently triggers its own
refresh — N parallel re-renders for the same key, each hitting your
origin once.

`singleFlight: true` adds an opt-in Redis lock (`refresh-tag-lock.lua`,
default TTL 10s) at the SWR boundary. The first instance to acquire it
becomes the **leader** and runs the refresh; the rest become
**followers**, keep serving the same stale entry, and wait for the
leader's write to land. The lock is observability-only at the handler
layer — Next.js still drives the actual refresh; we just suppress the
stampede.

```js
createCacheComponentsHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  singleFlight: true,         // default false
  singleFlightLockTtlSec: 10, // default 10
});
```

Two new `MetricEvent` types appear on `onMetric`:

| event type | meaning |
|---|---|
| `cache.stale.refresh.leader` | this instance just acquired the lock and is the designated refresher |
| `cache.stale.refresh.follower` | another instance holds the lock; we serve stale and skip the refresh |

If lock acquisition fails (Redis hiccup, TTL race), the handler
defaults to the follower path — the stale entry is always served, never
dropped. This is intentional: the lock is an optimization, not a
correctness-critical primitive.

When **not** to enable single-flight: small fleets (1–2 instances) where
Next's per-process serialization already covers the stampede risk.
Adding a Redis round-trip per stale read isn't free.

See [`docs/architecture.md`](./docs/architecture.md#single-flight-refresh-lock-v02-)
for the full state machine and a reference to the Lua script body.

---

## OpenTelemetry instrumentation (v0.2)

The handler doesn't bundle `@opentelemetry/api` (zero runtime
dependencies stays a goal). Instead, the `onMetric(event)` hook gives
strictly-typed events you can pipe into whatever observability stack
you already run.

[`examples/opentelemetry/`](./examples/opentelemetry/) is a copy-paste
reference wrapper that:

- exposes a `nextjs_cache.events_total` counter dimensioned on
  `type` / `freshness` / `backend` / `reason` / `op`
- exposes a `nextjs_cache.op_latency_ms` histogram for events that
  carry an `ms` field
- keeps cardinality bounded — cache keys and tag names are never
  emitted as attributes

See [`examples/opentelemetry/README.md`](./examples/opentelemetry/README.md)
for setup and three suggested dashboards (hit rate, single-flight
leadership distribution, op latency tails).

---

## How it differs from `@fortedigital/nextjs-cache-handler`

Three deliberate departures, all rooted in lessons from production
incidents (see [`docs/`](./docs/)):

1. **Build-phase skip is the default**, not an opt-in. Every Redis call
   goes through a `shouldUseRedis()` gate that short-circuits when
   `process.env.NEXT_PHASE === "phase-production-build"`. PR #207 on
   `@fortedigital` was rejected for missing exactly this.
2. **Deployment isolation is automatic**. Every entry key includes
   `BUILD_NAMESPACE` (=`process.env.DEPLOYMENT_VERSION`) by default. New
   deploys can never read entries written by old ones — fixes the
   "static chunk 404 after deploy" failure mode without manual cache
   flushes.
3. **Lua-atomic tag updates**. `set` writes the entry and updates tag
   indices in a single Lua transaction. `updateTags(..., {expire: 0})`
   removes matching entries with one `EVALSHA`. No window for half-applied
   sets to leak dangling tag members.

When `@fortedigital` ships its `cacheHandlers` support (PR #207 / feature
branch `feature/cache-components`), this package will continue to differ
on (2) and (3). For (1), we consider it table-stakes; the upstream's
eventual implementation should converge on the same behavior.

---

## Migrating from another cache handler

Coming from `@neshca/cache-handler` (or its forks like
`@jadkins89/next-cache-handler`)? There's a dedicated guide with a full
API/concept mapping, config diff, and a seeding replacement:
[docs/migrating-from-neshca.md](docs/migrating-from-neshca.md).

---

## Compatibility

> **Upgrading to Next.js 16.3?** Two behavioral notes: (1) 16.3 changed the
> internal fetch-cache key format (`v3` → `v4`), so 16.2-era fetch entries
> become unreadable orphans — deploy with a new `DEPLOYMENT_VERSION` and let
> the old namespace age out via TTL. (2) An ISR entry found past its
> `cacheLife` **expire** now triggers a blocking revalidation instead of
> serving stale (matching `'use cache'` semantics); within
> `revalidate..expire` stale-while-revalidate is unchanged.

- **Next.js**: `>=15.0.0 <17`
  - `cacheHandler` (singular, ISR): Next **15 and 16** — the handler accepts
    both ctx shapes (Next 15's `ctx.revalidate` / `kindHint`, Next 16's
    `ctx.cacheControl` / `kind`)
  - `cacheHandlers` (plural, `'use cache'`): Next **>=16.1.5** only — the
    interface does not exist before 16
- **Node.js**: `>=20`
- **redis**: `>=5.0.0` (peer, optional)
- **ioredis**: `>=5.0.0` (peer, optional) — also powers `type: "cluster"` and
  `type: "sentinel"` (Sentinel master discovery with automatic failover)

ESM and CJS dual-published, full TypeScript types, validated via
[`arethetypeswrong`](https://arethetypeswrong.github.io) and
[`publint`](https://publint.dev).

---

## Roadmap

- **v0.1.0** *(2026-05)* — Both handlers, SWR, Lua atomicity, build-phase
  skip, `redis@5` + `ioredis` adapters, AbortSignal, in-memory fallback
  with TTL, soft-tag freshness check ✅
- **v0.2.0** *(2026-05)* — Single-flight refresh lock with leader/follower
  metrics, OpenTelemetry reference adapter, integration tests against
  real Redis 7 (21 scenarios over `redis@5` + `ioredis`), GitHub Actions
  OIDC publish path with provenance attestation ✅
- **v0.3.0** *(2026-08)* — Next.js 15 ISR support, reconnect backoff (no
  permanent connect-failure latch), request-scoped GET deduplication,
  gzip/brotli compression, Redis Sentinel, built-in OpenTelemetry emitter
  (`/otel`), LRU-bounded memory fallback, ESM peer-loading fixes ✅
- **v0.4.0** *(2026-08)* — Build-output cache seeding (`seed` CLI, NX-safe),
  pub/sub tag propagation, Redis Cluster e2e in CI, `init`/`doctor` CLI,
  agent assets (skill, rules, MCP server) ✅
  - *0.4.1* — Buffer serialization fix (~2.8x smaller ISR payloads) ✅
  - *0.4.2* — upstream-exact tag invalidation semantics: no-durations
    `updateTags` is hard (`updateTag()` read-your-own-writes), profile
    durations are soft with a real hard deadline; tag-stale entries are
    served with `revalidate: -1` instead of a backdated timestamp ✅
- **v0.5** — Vercel KV / Upstash adapter, `'use cache: remote'` multi-tier
  setup, `neshClassicCache` equivalent

---

## License

[MIT](./LICENSE) © 2026 Eddy Lee
