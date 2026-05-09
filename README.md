# @leejpsd/nextjs-cache-handler

[![npm](https://img.shields.io/npm/v/@leejpsd/nextjs-cache-handler.svg)](https://www.npmjs.com/package/@leejpsd/nextjs-cache-handler)
[![license](https://img.shields.io/npm/l/@leejpsd/nextjs-cache-handler.svg)](./LICENSE)

> **Stable `v0.1.0`** — install with
> `npm install @leejpsd/nextjs-cache-handler`. Production-validated against
> AWS ECS Fargate with multi-instance Redis (24h live-traffic soak: 0
> errors, 0 leaks, 2ms Redis ping, namespace isolation working).

The Redis cache handler for **Next.js 16** that ships **both** `cacheHandler`
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

| Next 16 feature | @fortedigital | this |
|---|---|---|
| `cacheHandlers` config (plural) | ❌ Help needed | ✅ |
| `'use cache'` directive | ❌ Help needed | ✅ |
| `'use cache: remote'` | ❌ Help needed | ✅ |
| `'use cache: private'` | n/a (uncustomizable) | n/a |
| `cacheComponents: true` | ❌ Help needed | ✅ |
| Build-phase skip (`PHASE_PRODUCTION_BUILD`) | ✅ | ✅ |
| Auto deploy isolation (`BUILD_NAMESPACE`) | manual | ✅ auto |
| Lua-atomic SET+tag | partial (MULTI) | ✅ |
| AbortSignal timeout | ✅ | ✅ |
| Redis Cluster | ✅ | ✅ |
| ioredis support | ✅ | ✅ |
| In-memory fallback (TTL-aware) | partial | ✅ |
| OpenTelemetry hook | ❌ | ✅ (`onMetric`) |

PR [#207](https://github.com/fortedigital/nextjs-cache-handler/pull/207) on
`@fortedigital` has been stalled for 3+ months on the same issue: the
upstream review insisted on `PHASE_PRODUCTION_BUILD` handling, which this
package has from the start.

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
  keyPrefix?: string;            // default: "next-cache:" / "next-incremental:"
  buildNamespace?: string | (() => string);  // default: env DEPLOYMENT_VERSION || GIT_HASH || "unversioned"
  abortTimeoutMs?: number;       // default: 1500
  fallback?: "auto" | "always" | "never";    // default: "auto"
  staleWhileRevalidate?: boolean; // default: true (cache-components only)
  isBuildPhase?: () => boolean;  // override PHASE_PRODUCTION_BUILD detection
  hashTag?: boolean;             // default: false (set true on Redis Cluster)
  onMetric?: (event: MetricEvent) => void;
  logger?: Logger;
}

type RedisClientConfig =
  | { type: "redis";    url: string; password?: string; tls?: boolean; connectTimeout?: number }
  | { type: "ioredis";  url: string; password?: string; tls?: boolean; connectTimeout?: number }
  | { type: "cluster";  nodes: { host: string; port: number }[]; password?: string; tls?: boolean };
```

Full reference: [`docs/api.md`](./docs/api.md) (auto-generated).

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
- [ ] **Redis `maxmemory-policy: allkeys-lru` or `noeviction`** — if you need
      bounded memory, choose `allkeys-lru`. Otherwise `noeviction` keeps
      tag indices intact.
- [ ] **TLS** — use `rediss://` URLs (e.g. ElastiCache in-transit
      encryption). The library auto-detects from the URL scheme.
- [ ] **Health check** — call your own `/api/health` that pings Redis
      (separate from the handler) so a Redis outage surfaces in your
      monitoring without inducing 5xx in user requests.

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

## Compatibility

- **Next.js**: `>=16.1.5 <17`
- **Node.js**: `>=20`
- **redis**: `>=5.0.0` (peer, optional)
- **ioredis**: `>=5.0.0` (peer, optional)

ESM and CJS dual-published, full TypeScript types, validated via
[`arethetypeswrong`](https://arethetypeswrong.github.io) and
[`publint`](https://publint.dev).

---

## Roadmap

- **v0.1.0** *(target: 2026-05)* — Both handlers, SWR, Lua atomicity,
  build-phase skip, `redis@5` + `ioredis` adapters, AbortSignal,
  in-memory fallback with TTL, soft-tag freshness check
- **v0.2.0** — Single-flight refresh lock (Lua SETNX), OpenTelemetry
  forwarder example
- **v0.3.0** — Vercel KV / Upstash Redis adapter, `'use cache: remote'`
  multi-tier setup
- **v0.4.0** — Cache stampede protection, request-scoped memoization

---

## License

[MIT](./LICENSE) © 2026 Eddy Lee
