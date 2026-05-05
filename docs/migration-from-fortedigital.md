# Migration from `@fortedigital/nextjs-cache-handler`

This guide is for projects already using
[`@fortedigital/nextjs-cache-handler`](https://github.com/fortedigital/nextjs-cache-handler)
on Next.js 15 / 16, considering a switch to gain `'use cache'` /
`cacheComponents` support.

## When to migrate

✅ You use Next.js 16 and want to enable `cacheComponents: true` /
`'use cache'` directives.

✅ Your app runs on multiple instances (ECS, Kubernetes, multi-container
Fly.io) and you've hit cross-deployment cache bleed.

⚠️ You only use Pages Router ISR with no plans for Cache Components — the
two libraries have feature parity here. Migration buys you the
deployment isolation guarantee but otherwise is sideways.

## Compatibility table

| Feature | `@fortedigital@3.2.0` | `@leejpsd/nextjs-cache-handler@0.1` |
|---|---|---|
| `cacheHandler` (singular ISR) | ✅ | ✅ |
| `cacheHandlers` (plural `'use cache'`) | ❌ Help needed | ✅ |
| `'use cache: remote'` | ❌ Help needed | ✅ |
| `cacheComponents: true` | ❌ Help needed | ✅ Production-validated |
| Build-phase skip | ✅ | ✅ |
| Auto deploy isolation | manual | ✅ default-on |
| Lua-atomic SET+tag | partial (MULTI) | ✅ |
| AbortSignal timeout | ✅ via `withAbortSignalProxy` | ✅ via `withAbortSignal` |
| Composite handler | ✅ (`composite-handler.js`) | ❌ (out of scope for v0.1) |
| LRU local handler | ✅ (`local-lru-handler`) | ❌ (use `fallback: "always"`) |

## Side-by-side configuration

### `@fortedigital`

```js
// cache-handler.js
const { CacheHandler } = require("@fortedigital/nextjs-cache-handler/cache-handler");
const { redisCacheHandler } = require("@fortedigital/nextjs-cache-handler/redis-strings");
const { createClient } = require("redis");

CacheHandler.onCreation(async () => {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return {
    handlers: [redisCacheHandler({ client, keyPrefix: "next-cache:" })],
  };
});
module.exports = CacheHandler;
```

```ts
// next.config.ts
const nextConfig = {
  cacheHandler: require.resolve("./cache-handler.js"),
  cacheMaxMemorySize: 0,
};
```

### `@leejpsd/nextjs-cache-handler`

```js
// cache-incremental.cjs
const { createIncrementalCacheHandler } = require("@leejpsd/nextjs-cache-handler/incremental");
module.exports = createIncrementalCacheHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  keyPrefix: "next-cache:",
  buildNamespace: process.env.DEPLOYMENT_VERSION,
});
```

```js
// cache-components.cjs
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");
module.exports = createCacheComponentsHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  keyPrefix: "next-cache:",
  buildNamespace: process.env.DEPLOYMENT_VERSION,
});
```

```ts
// next.config.ts
const nextConfig = {
  cacheComponents: true,
  cacheHandler: require.resolve("./cache-incremental.cjs"),
  cacheHandlers: { default: require.resolve("./cache-components.cjs") },
  cacheMaxMemorySize: 0,
};
```

## Behavioral differences to be aware of

### Tag invalidation propagation across deployments

`@fortedigital`: tag state is namespaced per build/deploy in some
configurations. `revalidateTag` from a new deploy may not reach old
deployments (they're rolling out anyway).

`@leejpsd`: **entry keys are namespaced** per deployment, but **tag-state
keys are not**. A `revalidateTag` from a new deploy is observable by all
deployments simultaneously. This is the deliberate design — it lets a
hotfix deploy invalidate stale entries written by the previous version.

### Empty `tags` arrays in `set()`

`@fortedigital`: writes the entry with no tag indices (correct).

`@leejpsd`: writes the entry via plain `SET` (skips Lua) when
`entry.tags.length === 0`. Same effect, fewer network bytes.

### `expire: 0` semantics

`@fortedigital`: hard expire — drop the entry immediately.

`@leejpsd`: same. Internally maps to `revalidate-hard.lua` which removes
all entries referenced by the tag and bumps the marker key. Plus
propagates failure to the caller (per spec § 6 — hard invalidation must
not be silent).

### Memory fallback policy

`@fortedigital`: requires explicit `local-lru-handler` configured in a
`composite` to get fallback.

`@leejpsd`: built into every handler. Active when Redis is unreachable
(`fallback: "auto"`, default), forced via `fallback: "always"`, or
disabled with `fallback: "never"`.

## Migration steps

1. **Install both packages temporarily** so you can A/B test:
   ```bash
   npm install @leejpsd/nextjs-cache-handler
   ```

2. **Add the two CJS wrapper files** as shown above. Do **not** delete
   your existing `cache-handler.js`.

3. **Add an env-driven toggle to `next.config.ts`**:
   ```ts
   const useNew = process.env.USE_LEEJPSD_HANDLER === "true";
   const cacheHandlerPath = useNew
     ? "./cache-incremental.cjs"
     : "./cache-handler.js";
   const nextConfig = {
     cacheHandler: require.resolve(cacheHandlerPath),
     cacheHandlers: useNew
       ? { default: require.resolve("./cache-components.cjs") }
       : {},
     cacheComponents: useNew, // only enable with the new handler
   };
   ```

4. **Roll out gradually**: enable on staging, monitor for 24h, then
   production. Rollback is one env-var flip.

5. **Once validated**, remove the old wrappers and `@fortedigital` from
   dependencies.

## Open questions / known unknowns

- **Composite handler equivalent**: this package doesn't have a
  composite layer. If you currently use one to chain LRU → Redis,
  configure `fallback: "auto"` and rely on the built-in memory store.
  Multi-tier coordination across handler instances is not yet supported.
- **`local-lru-handler` parity**: not 1:1. The built-in memory store is
  per-process and uses `setTimeout` for eviction, not LRU bounds.
  Consider this when sizing memory limits.

## Reporting migration issues

If you hit a behavioral surprise during migration, please file an issue
with the side-by-side `next.config.ts` snippet and a minimal repro. The
spec snapshot in [`docs/next16-spec.md`](./next16-spec.md) is the source
of truth for resolving disagreements.
