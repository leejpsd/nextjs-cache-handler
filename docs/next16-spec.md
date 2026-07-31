# Next.js 16 Cache Handler — Frozen Spec Reference

> Last verified: 2026-05-05 against Next.js 16.2.4 documentation.
> Sources:
> - https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers
> - https://nextjs.org/docs/app/api-reference/directives/use-cache
> - https://nextjs.org/docs/app/guides/how-revalidation-works
> - https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheLife

This file is the canonical contract that `src/cache-components/handler.ts` and
`src/incremental/handler.ts` must implement against. When the docs change,
update this file first, then propagate to code.

---

## 1. Two distinct handler systems

Next.js 16 splits cache handling into two **independent** mechanisms that can
coexist in one app:

| Option | Used by | Interface | Status |
|---|---|---|---|
| `cacheHandlers` (plural) | `'use cache'` directive, Cache Components | New 5-method interface (this doc §2) | Introduced in v16.0.0 |
| `cacheHandler` (singular) | Pages Router ISR, on-demand ISR (`res.revalidate()`, `x-prerender-revalidate`) | Legacy 4-method interface (this doc §3) | Still supported — *"Pages Router on-demand ISR APIs are still supported and use the server cache handler (cacheHandler, singular). The cacheHandlers option (plural) is for 'use cache' directives."* |

> **`'use cache: private'` is NOT configurable.** It always uses Next.js's
> internal handler. Our package does not expose a private cache handler.

---

## 2. `cacheHandlers` (plural) — for `'use cache'`

### 2.1 Configuration

```ts
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,             // required to enable 'use cache'
  cacheHandlers: {
    default: require.resolve('./cache-handlers/default-handler.js'),
    remote:  require.resolve('./cache-handlers/remote-handler.js'),
    // sessions: require.resolve('./cache-handlers/sessions.js'),  // custom names allowed
  },
}
```

| Key | Used by directive |
|---|---|
| `default` | `'use cache'` |
| `remote` | `'use cache: remote'` |
| `<custom>` | `'use cache: <custom>'` |

If `cacheHandlers` is not configured, Next.js falls back to an in-memory LRU
for both `default` and `remote`.

### 2.2 Required interface (verbatim from official spec)

```ts
interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];        // explicit tags only (NOT soft tags)
  stale: number;         // seconds (client-side staleness)
  timestamp: number;     // ms since epoch (entry creation)
  expire: number;        // seconds (max usable age)
  revalidate: number;    // seconds (background refresh trigger)
}
```

### 2.3 Method semantics

#### `get(cacheKey, softTags)`

- Returns the entry if found and not yet hard-expired, else `undefined`.
- **Important**: `softTags` are passed separately from `entry.tags`. The
  handler's responsibility is to consult `getExpiration(softTags)` (or its own
  per-soft-tag tracking) and treat the entry as stale if any soft tag was
  invalidated *after* `entry.timestamp`.
- **Error policy**: *"The framework does not wrap `get()` in a try/catch, so an
  unhandled exception from `get()` will propagate as a render error."*
  → handler MUST swallow internal errors and return `undefined` on cache
  miss / failure.

#### `set(cacheKey, pendingEntry)`

- `pendingEntry` is a Promise that may not be resolved yet because the entry's
  `value` stream may still be writing.
- Handler MUST `await pendingEntry` before reading `value`.
- After awaiting, `value: ReadableStream<Uint8Array>`. If you need to both
  store and pass through, use `.tee()`.
- **Error policy**: *"the response is still served to the user because `set()`
  is called asynchronously after the response stream is already flowing."*
  → `set()` failures are best-effort. Log and move on.
- **Partial writes**: *"the stream may error partway through rendering. Your
  handler should decide whether to keep partial entries or discard them.
  Discarding is safer."*

#### `refreshTags()`

- Called *"periodically, but always before starting a new request"* (per
  how-revalidation-works).
- Single-instance / in-memory: no-op is correct.
- Multi-instance: pull recent invalidation events from shared storage and
  update local tag-timestamp state.
- **Error policy**: *"Your handler must catch errors in `refreshTags()`: if it
  throws, the exception propagates as a request failure."*

#### `getExpiration(tags)`

Returns:
- `0` — none of these tags have ever been invalidated
- `<timestamp ms>` — most recent invalidation across the provided tags
- `Infinity` — *"indicate soft tags should be checked in the `get` method
  instead"*. Useful when soft-tag tracking is too heavy to centralize and the
  handler embeds per-entry soft-tag freshness checks.

> ⚠️ **Verified against `next@16.2.3` source (2026-08-01, issue #1):** the
> framework calls `getExpiration()` with the **implicit route tags only**
> (`implicit-tags.js`). For an entry's *explicit* `cacheTag()` tags,
> `shouldDiscardCacheEntry()` consults nothing beyond the current action's
> `pendingRevalidatedTags`/`previouslyRevalidatedTags` — it never asks the
> handler. Cross-request/cross-instance soft invalidation of explicit tags
> is therefore **entirely `get()`'s responsibility**: the handler must fold
> `entry.tags` into its freshness check, not just the `softTags` parameter.
> Missing this made `revalidateTag(tag, "max")` a silent no-op (#1).

#### `updateTags(tags, durations?)`

- Called when `revalidateTag(tag)` or `updateTag(tag)` fires.
- `durations.expire`:
  - **`0`** — hard expire. Entries should be removed *now*. This is the
    `updateTag()` server-action path (read-your-own-writes semantics).
  - **`undefined`** — soft expire / revalidate. Entries can stay; the next
    `getExpiration()` should report this tag's timestamp so subsequent reads
    treat them as stale.
  - **positive number** — entries should be kept fresh until `now + expire*1000`.

### 2.4 Multi-instance distributed coordination (verbatim guidance)

> 1. **`updateTags()`** is called when `revalidateTag()` is invoked. Your
>    handler should write the invalidation timestamp to shared storage.
> 2. **`refreshTags()`** is called before each request. Your handler should
>    read recent invalidation events from shared storage and update its local
>    tag state.
> 3. **`getExpiration()`** returns the most recent revalidation timestamp
>    across all provided tags. The default implementation returns
>    `Math.max(...timestamps, 0)`.

### 2.5 Build-phase behavior

`cacheHandlers` ARE invoked during `next build` (prerender pass). A handler
that connects unconditionally to Redis at module import will fail the build
with `ECONNREFUSED` in environments where Redis is not reachable from the
build host (CI, Docker `RUN npm run build`, etc.).

→ Handler must check `process.env.NEXT_PHASE === 'phase-production-build'` and
short-circuit Redis calls. This package implements that gate in
`src/shared/build-phase.ts`. This is the same root cause that left
`@fortedigital/nextjs-cache-handler` PR #207 stalled.

### 2.6 Soft tag prefix

Soft tags use the `_N_T_` prefix internally. Examples for route `/blog/hello`:
```
_N_T_/layout
_N_T_/blog/layout
_N_T_/blog/hello/layout
_N_T_/blog/hello
```
Soft tags arrive in `get()`'s second argument; they are NOT stored in
`entry.tags`.

---

## 3. `cacheHandler` (singular) — for ISR / Pages Router

The dedicated documentation page was removed in 16.2 docs but the option
itself is still supported per how-revalidation-works:

> *"Pages Router on-demand ISR APIs (for example `res.revalidate()` and the
> `x-prerender-revalidate` flow) are still supported and use the server cache
> handler (`cacheHandler`, singular). The `cacheHandlers` option (plural) is
> for `'use cache'` directives."*

### 3.1 Interface (carried over from Next 14/15)

```ts
class CacheHandler {
  async get(key: string, ctx?: { kind?: string; tags?: string[]; softTags?: string[] }): Promise<CacheData | null>;
  async set(key: string, data: CacheData | null, ctx?: { tags: string[]; revalidate?: number; fetchCache?: boolean }): Promise<void>;
  async revalidateTag(tag: string | string[]): Promise<void>;
  resetRequestCache(): void;
}

interface CacheData {
  value: Buffer | string | { kind: string; [key: string]: unknown } | null;
  lastModified?: number;
  tags?: string[];
}
```

### 3.2 `ctx.kind` enum

- `'APP_PAGE'` — App Router page (HTML + RSC payload)
- `'APP_ROUTE'` — App Router route handler response
- `'PAGES'` — Pages Router page
- `'FETCH'` — `fetch(..., { next: { tags } })` cached response
- `'IMAGE'` — Optimized image (Next 16.2+)

Different `kind`s map to different TTL strategies — see `incremental-cache-handler.js`
of the reference implementation: FETCH gets capped at one year, others at
their `Cache-Control` revalidate value, both with a 60s minimum floor.

### 3.3 Coexistence

A single Next.js app can configure both:

```ts
const nextConfig: NextConfig = {
  cacheHandler: require.resolve('./cache-handler.js'),    // legacy ISR
  cacheHandlers: {                                         // new 'use cache'
    default: require.resolve('./cache-handlers/default.js'),
  },
  cacheComponents: true,
}
```

This package supports both via separate factories
(`createIncrementalCacheHandler`, `createCacheComponentsHandler`). They share
infrastructure (`src/shared/`) but have independent state.

---

## 4. cacheLife profiles (default values)

| Profile | stale (sec) | revalidate (sec) | expire (sec) |
|---|---|---|---|
| `default` | 300 (5m) | 900 (15m) | `Infinity` |
| `seconds` | 0 | 1 | 60 |
| `minutes` | 300 | 60 | 3600 |
| `hours`   | 300 | 3600 | 86400 |
| `days`    | 300 | 86400 | 604800 |
| `weeks`   | 300 | 604800 | 2592000 |
| `max`     | 300 | 2592000 | `Infinity` (effectively) |

Custom profiles are defined in `next.config.ts#cacheLife` and identified by
name when calling `cacheLife('blog')`. The handler does NOT see the profile
name — only the resolved `{stale, revalidate, expire}` values via the
`CacheEntry` fields.

`expire: Infinity` is the sentinel for "never hard-expire by time". Our
handler maps it to a one-year TTL (matches reference implementation behavior).

---

## 5. revalidateTag vs updateTag

| API | Caller location | `durations.expire` to handler | Semantics |
|---|---|---|---|
| `revalidateTag(tag, profile)` | anywhere | profile-resolved (typically `undefined` for soft) | Soft. SWR — show stale, refresh in background |
| `updateTag(tag)` | Server Actions ONLY | `0` | Hard. Immediately invalidate. Read-your-own-writes |
| `revalidatePath(path)` | anywhere | uses soft tag invalidation | Iterates the path's soft tags through `updateTags(softTagList, undefined)` |

The 2-arg form `revalidateTag('posts', 'max')` is the v16+ signature. The
1-arg form is deprecated.

---

## 6. Error handling policy summary

| Path | On error |
|---|---|
| `get()` | Return `undefined` (cache miss). Never throw. |
| `set()` | Log and ignore (response already streaming). Never throw. |
| `refreshTags()` | MUST catch internal errors. If it throws, the request fails. |
| `getExpiration()` | Best-effort. On failure return `0` (treat as never invalidated) or last-known. |
| `updateTags()` | Soft (`expire` undefined): can swallow errors. Hard (`expire === 0`): SHOULD propagate so the user sees the failure rather than serving stale data. |

---

## 7. Graceful degradation philosophy (verbatim)

> *"Cache failures result in degraded performance (stale content, extra
> renders), not broken applications."*

This is the north star. The handler chooses correctness-of-service over
correctness-of-cache when they conflict.

---

## 8. Cross-deployment skew

> *"During rolling deployments, configure `deploymentId` so that a build ID
> change triggers a hard navigation to fetch consistent content."*

Our package layers a stronger guarantee on top: every entry key is prefixed
with `BUILD_NAMESPACE` (= `process.env.DEPLOYMENT_VERSION ??
process.env.GIT_HASH`). New deployments cannot read entries written by old
deployments at all. See `src/shared/namespace.ts`.

---

## 9. Spec drift watch

To detect when this file goes stale:

```bash
# Re-run periodically and diff
curl -s 'https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers.md' \
  | sha256sum
```

Add a CI job `verify-spec-snapshot.yml` that fails when the snapshot hash
changes, forcing a manual re-review of this document.
