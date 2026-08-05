# Changelog

## 0.4.2

### Patch Changes

- [`c165563`](https://github.com/leejpsd/nextjs-cache-handler/commit/c16556385a7fb3e8e95dfddc9015dde7a887311a) Thanks [@leejpsd](https://github.com/leejpsd)! - Align `'use cache'` tag invalidation exactly with upstream semantics.

  **Fixed: hard/soft polarity was inverted for `updateTags` without durations.** Next.js calls `updateTags(tags)` with NO durations for hard invalidation (`updateTag()` server actions, single-arg `revalidateTag()`) and `updateTags(tags, { expire })` for profile-based soft invalidation (`revalidateTag(tag, "max")`). The handler treated no-durations as soft, so `updateTag()` — which must guarantee read-your-own-writes — could serve stale content. No-durations is now hard.

  Also in this release:
  - Soft invalidations now honor their hard deadline: entries serve stale until `durations.expire` seconds after the invalidation, then miss (`Infinity` = never). Tag markers store a `"<stale>|<expired>"` pair; 0.4.1 readers `parseInt` the same marker safely, and legacy bare-number markers are treated as hard-at-timestamp, so mixed-version fleets stay correct in both directions.
  - Tag-stale entries are served with the truthful timestamp and `revalidate: -1` (the built-in handler's refresh signal) instead of a backdated timestamp, which could cross the `expire` boundary on tight profiles and confused the implicit-tags discard check.
  - Soft invalidations serve-while-revalidating regardless of `staleWhileRevalidate` (that option now governs time-based staleness only, matching the upstream contract).
  - `getExpiration` reports only the hard deadline, mirroring the built-in handler.
  - `expire: 0` entries are no longer persisted in production (mirrors Next 16.3's built-in handler; they are regenerated on every read anyway).
  - Verified end-to-end against Next.js 16.3.0 stable (both interfaces; build, serve, hard/soft invalidation, ISR SWR).

## 0.4.1

### Patch Changes

- [`8555fbe`](https://github.com/leejpsd/nextjs-cache-handler/commit/8555fbeb10c8681f101f13157a078b0a1e3fcea5) Thanks [@leejpsd](https://github.com/leejpsd)! - Fix ISR record serialization writing Buffers as JSON byte arrays instead of base64.

  `Buffer.prototype.toJSON` runs before a `JSON.stringify` replacer sees the value, so the base64 envelope branch was unreachable and every Buffer field (rendered HTML, RSC payloads, PPR segment data) was stored as `{ type: "Buffer", data: [...] }` — roughly 2.8x larger than base64. The replacer now reads the pre-`toJSON` original via `this[key]`.

  No migration needed: the reviver has always accepted both shapes, so records written by either version deserialize correctly in both directions.

## 0.4.0

### Minor Changes

- [#7](https://github.com/leejpsd/nextjs-cache-handler/pull/7) [`bf047c9`](https://github.com/leejpsd/nextjs-cache-handler/commit/bf047c937985dafabed7c60ab1972a749a8f3b9f) Thanks [@leejpsd](https://github.com/leejpsd)! - Build-output cache seeding: `seedBuildOutput()` (new `/seed` entry point) and
  `npx nextjs-cache-handler seed` walk `.next/` after a build and insert
  prerendered App Router routes (including PPR segment data), Pages Router
  routes, and fetch-cache entries into Redis in the handler's own record
  format — with NX semantics so entries already written by live instances are
  never overwritten. A fresh deployment's first requests are cache HITs
  instead of a regeneration stampede (verified on a real Next 16 app: cold
  server + seeded Redis → first request `x-nextjs-cache: HIT`). The
  `RedisClientLike.set` contract gains an optional `NX` flag.

- [#7](https://github.com/leejpsd/nextjs-cache-handler/pull/7) [`1e57e03`](https://github.com/leejpsd/nextjs-cache-handler/commit/1e57e03020926933f524796645b279d004dddf2a) Thanks [@leejpsd](https://github.com/leejpsd)! - New `nextjs-cache-handler` CLI (zero-dependency): `init` detects the Next.js
  version and Redis client, generates the handler wrapper shims, shows the
  next.config keys to add (never edits it), appends env templates, and injects
  the agent rules block into CLAUDE.md/AGENTS.md idempotently (`--yes` to
  apply, `--skills` to install the agent skill locally). `doctor` verifies
  Redis connectivity, inspects cache key namespaces, and runs a write/read
  round-trip — the first command an agent should reach for when debugging.

- [#7](https://github.com/leejpsd/nextjs-cache-handler/pull/7) [`6cd5901`](https://github.com/leejpsd/nextjs-cache-handler/commit/6cd59010d30b55e8a5f9b99db8ec53b0e64e03ce) Thanks [@leejpsd](https://github.com/leejpsd)! - Opt-in push-based tag propagation (`tagPubSub: true`, plural handler):
  `updateTags()` publishes invalidations on a namespaced channel and every
  instance maintains a subscription on a dedicated duplicate connection,
  updating its local tag mirror in ~3 ms (measured cross-instance over real
  Redis with both redis@5 and ioredis) instead of waiting for the next
  `refreshTags()` scan (~seconds). The scan keeps running as the consistency
  safety net, so a dropped subscription degrades to the previous behavior —
  never to staleness. Cluster clients fall back to polling with a one-time
  warning. `RedisClientLike` gains optional `publish`/`subscribe`.

## 0.3.4

### Patch Changes

- [`79e112b`](https://github.com/leejpsd/nextjs-cache-handler/commit/79e112bc03249e6e042da717c4558de733cc62f0) Thanks [@leejpsd](https://github.com/leejpsd)! - Ship agent-native assets in the package: `AGENTS.md` (agent guidance
  discovered via node_modules scans), an agent skill
  (`skills/nextjs-redis-cache/SKILL.md` — decision tables, invalidation
  semantics, troubleshooting playbook), agent-executable setup instructions
  (`setup-instructions/setup.md`), a project rules block (`rules/`), and
  `llms.txt`. README gains a "For AI agents" section. No runtime code changes.

## 0.3.3

### Patch Changes

- [`692b32b`](https://github.com/leejpsd/nextjs-cache-handler/commit/692b32b656b79ba33abacb6a19e12f26e48cb219) Thanks [@leejpsd](https://github.com/leejpsd)! - Complete the soft-invalidation fix at the route layer: the ISR handler now
  serves non-fetch entries whose tag was softly revalidated as
  stale-while-revalidate — `lastModified` is backdated just past the entry's
  own revalidate window (captured at set() time as `revalidateSec`) so Next
  serves the cached HTML instantly and regenerates in the background, which
  also re-executes the route's `'use cache'` functions. Entries without an SWR
  window (`revalidate: false` or pre-upgrade records) degrade to a blocking
  miss so the invalidation still lands. Verified end-to-end on Next 16.2.3
  with two instances sharing Redis: stale served in ~15 ms during an 800 ms
  render, background refresh converging both instances.

## 0.3.2

### Patch Changes

- [`6f35ff3`](https://github.com/leejpsd/nextjs-cache-handler/commit/6f35ff3d6eb6d84a842b8afc2677ae2545e2deba) Thanks [@leejpsd](https://github.com/leejpsd)! - Fix: soft revalidation of explicit `cacheTag()` tags — `revalidateTag(tag, "max")` — was a no-op on time-fresh entries. `get()` now folds the entry's own tags into the freshness check and serves tag-invalidated entries as stale-while-revalidate (backdated past `revalidate` so Next schedules a background re-render), matching the spec's soft-invalidation semantics. Hard invalidation (`{ expire: 0 }`) was already correct. Thanks to @eveyrat for the report (#1) and @unitedworldwrestling for the fix approach (#2).

## 0.3.1

### Patch Changes

- [`f07e91b`](https://github.com/leejpsd/nextjs-cache-handler/commit/f07e91b432be6d52885f2f0a83bfb6c63d519bbe) Thanks [@leejpsd](https://github.com/leejpsd)! - Refresh the npm package description and keywords for the 0.3 feature set:
  Next.js 15/16, built-in compression, Redis Sentinel, OpenTelemetry, and the
  multi-instance AWS validation results.

## 0.3.0

### Minor Changes

- [`dc1ac0a`](https://github.com/leejpsd/nextjs-cache-handler/commit/dc1ac0a0b29e73485f4af587f8ec0f4b68d1d54f) Thanks [@leejpsd](https://github.com/leejpsd)! - Reliability fixes (reconnect backoff instead of a permanent connect-failure
  latch, bounded memory fallback, namespace-scoped tag propagation without
  truncation, strict `fallback: "never"` honored by the ISR handler, working
  ESM peer loading) plus new features: Next.js 15 ISR support, request-scoped
  GET deduplication, transparent gzip/brotli value compression, Redis Sentinel
  support, a built-in OpenTelemetry adapter at `/otel`, and `memoryMaxEntries`.

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Next.js 15 support** for the singular `cacheHandler` (ISR): both ctx
  generations accepted (`ctx.revalidate`/`kindHint` and
  `ctx.cacheControl`/`kind`); `peerDependencies.next` widened to
  `>=15.0.0 <17`. Verified end to end against Next 15.5 (build, ISR
  HIT/MISS, tag/path revalidation, fetch-cache TTL, cross-process reads).
- **Request-scoped GET deduplication** (singular handler):
  `resetRequestCache()` is now a real implementation — duplicate reads of a
  cache key within one request share a single Redis GET. New metric event
  `cache.get.deduped`.
- **Transparent value compression** (`compression: "gzip" | "brotli"`,
  default off) via node:zlib — marker-prefixed storage with auto-detecting
  reads, safe to enable on a live cache with a mixed fleet. Payloads < 1 KiB
  stay plain.
- **Redis Sentinel support** (`{ type: "sentinel", sentinels, name }`) via
  ioredis master discovery — verified locally including a live failover.
- **Built-in OpenTelemetry adapter** at
  `@leejpsd/nextjs-cache-handler/otel` (`createOtelMetricEmitter`);
  `@opentelemetry/api` is an optional peer resolved at runtime.
- **`memoryMaxEntries` option** (default 1000) bounding the in-memory
  fallback stores with LRU eviction.

### Fixed

- **Connect failures no longer latch the process into memory-only mode.**
  Reconnects retry with exponential backoff (1s→30s cap) and dropped
  connections are replaced (dead clients disposed).
- **`refreshTags` scans only the current build namespace** and processes
  markers chunk-by-chunk — the previous 500-key cap silently left tags
  unpropagated; the local mirror is now rebuilt per complete scan (bounded
  by live markers) and `memTagExp` is capped.
- **`fallback: "never"` is honored by the singular handler** (it previously
  read/wrote the memory fallback unconditionally, silently degrading strict
  mode to per-process caching).
- **ESM build can load optional peers**: bare `require()` calls became
  esbuild's throwing `__require` fallback in ESM; now routed through
  `createRequire` with a CWD fallback for symlinked installs (npm file
  installs, pnpm).

### Changed

- Multi-tag `updateTags` fans out concurrently (one round trip via
  auto-pipelining) instead of one await per tag; ioredis clients enable
  `enableAutoPipelining`.
- Removed the declared-but-never-emitted `cache.stale.refresh.skipped`
  metric event type.

## [0.2.0] - 2026-05-10

First minor bump. Three differentiators land in this release.

### Added

- **Single-flight refresh lock** (`singleFlight: true`,
  `singleFlightLockTtlSec: 10`). Opt-in stampede protection at the SWR
  boundary. Uses the bundled `refresh-tag-lock.lua` script over a Redis
  SETNX-style lock; only the leader's stale read triggers the
  background refresh, all others fall through to the follower path.
  Two new `MetricEvent` types (`cache.stale.refresh.leader`,
  `cache.stale.refresh.follower`) appear in `onMetric` so operators can
  verify leadership balance. Lock-acquisition failures are best-effort
  and always degrade to the safe follower path; the stale entry is
  served regardless.
- **OpenTelemetry reference adapter** at
  [`examples/opentelemetry/`](./examples/opentelemetry/). The library
  itself stays dependency-free; the example shows the smallest viable
  wiring of `onMetric` to OTel counters and histograms with bounded
  cardinality (no cache keys or tag names emitted as attributes).
- **Integration tests against real Redis 7** (21 scenarios) covering
  both `redis@5` and `ioredis` adapters. Each adapter runs the same
  test grid so a regression in either client library is pinpointed
  immediately. New scripts: `npm run test:integration`,
  `npm run test:integration:up` / `:down` for the docker-compose
  fixture.
- **CI integration job** runs the integration suite against an
  ephemeral Redis 7 service container on every PR.
- **GitHub Actions OIDC publish path** in `.github/workflows/release.yml`
  with `id-token: write` and `NPM_CONFIG_PROVENANCE=true`. Currently
  scoped to `workflow_dispatch` trigger so the first GHA-driven publish
  can be observed; flip to `push: main` once the changesets cadence
  stabilizes. Tarballs published from the workflow will land on npm
  with verified provenance.

### Changed

- `MetricEventType` union grew three new entries:
  `cache.stale.refresh.leader`, `cache.stale.refresh.follower`,
  `cache.stale.refresh.skipped`. The legacy `cache.stale` event still
  fires when `singleFlight` is off (default).
- `HandlerState` now carries an `instanceId` (read from `HOSTNAME` /
  `ECS_TASK_ID` / `pid-<pid>`) and embeds it in every refresh-lock
  acquisition for operator-side observability.

### Compatibility

- No breaking changes. All existing 0.1.x configurations continue to
  work; `singleFlight` defaults to `false`.

### Verified

- 72 unit tests (8 files) + 21 integration tests (1 file × 21 scenarios)
  all green.
- arethetypeswrong: 28/28 cells green.
- publint: clean.

## [0.1.1] - 2026-05-10

Documentation-only patch released alongside the first round of external
write-ups. No code changes.

### Changed

- **Compatibility matrix** now carries an explicit verification date and a
  `nextjs-turbo-redis-cache` column, so readers can spot-check the comparison
  against the upstream READMEs as both packages evolve. The previous
  two-column shape didn't make it obvious which competitors are tracked.
- **Production checklist** gains an explicit Redis Cluster row: cluster
  deployments must set `hashTag: true` to avoid `CROSSSLOT` errors from
  the multi-key Lua scripts. Also notes that cluster support is
  unit-tested but not yet load-tested at scale.
- **Compatibility table for Redis-protocol services** (ElastiCache,
  Upstash, DragonflyDB, KeyDB, Vercel KV) added to the production
  section, separating "validated" from "expected to work via the
  standard Redis protocol".
- **`docs/architecture.md`** now documents two memory-fallback caveats
  that previously required reading the source: per-process isolation
  (cross-instance correctness degrades during Redis outages) and the
  32-bit `setTimeout` clamp (TTLs above ≈24.85 days fire the eviction
  timer early, though `get()`'s lazy `expiresAt` check still honors the
  configured expiration).

## [0.1.0] - 2026-05-10

First stable release. Promoted from `0.1.0-rc.1` after a 24-hour live-traffic
soak on AWS ECS Fargate (multi-instance, ElastiCache Redis): 0 errors, 0
entry leaks, Redis ping stable at 2ms, namespace isolation confirmed in
runtime cache key shapes.

### Verified during dogfood

- Library wrapper modules require'd successfully on every staging task
  (CloudWatch `[lib-incremental]` / `[lib-cache-components]` startup
  signals)
- Cache entries written with `BUILD_NAMESPACE` prefix
  (`next-cache:entry:<sha>:...`) — confirms deployment isolation
- `revalidateAccepted: 1` round-trip latency 193ms across the ALB; Server
  Action `revalidateTag` propagates without errors
- Static chunks resolve 200 across both `/dashboard` and `/experiments`
  routes — the static-chunk-404 incident remediation is live

### Pre-1.0 caveats

- Released under 0.1.x — APIs may receive small adjustments before 1.0
- Single-flight refresh lock is bundled (`refresh-tag-lock.lua`) but the
  handler-side wiring lands in v0.2
- Provenance attestation is disabled for the local-publish flow; v0.2
  will switch to GitHub Actions OIDC publish

### Added — `cacheHandlers` (plural) for `'use cache'`

- `createCacheComponentsHandler(opts)` factory implementing the full
  Next.js 16 spec: `get`, `set`, `refreshTags`, `getExpiration`,
  `updateTags`
- 3-axis stale-while-revalidate partition (fresh / stale / expired)
- Lua-atomic `SET entry + SADD tag + EXPIRE tag` via `set-with-tags.lua`
- Lua-atomic hard invalidation via `revalidate-hard.lua`
- Soft-tag freshness check (per spec § 2.3)
- ReadableStream serialization to base64 envelopes

### Added — `cacheHandler` (singular) for ISR / Pages Router

- `createIncrementalCacheHandler(opts)` factory returning a class
  compatible with `next.config.ts#cacheHandler`
- Buffer/Map JSON serialization preserved across Redis round-trip
- Tag-state model with separate `stale` (FETCH-only) and `expired`
  semantics
- `instance-local:*` tag prefix bypasses Redis (per-instance cache)

### Added — Shared infrastructure

- `BUILD_NAMESPACE` automatic deployment isolation
  (`DEPLOYMENT_VERSION` ?? `GIT_HASH` ?? `unversioned`)
- `withAbortSignal` timeout wrapper (default 1500ms; `CacheTimeoutError`)
- Build-phase skip via `process.env.NEXT_PHASE === "phase-production-build"`
  detection — fixes PR #207 root cause
- TTL-aware in-memory fallback with 32-bit `setTimeout` clamp
- `RedisClientLike` adapters: `redis@5`, `ioredis`, `ioredis.Cluster`
- `EVALSHA` with `EVAL` fallback on `NOSCRIPT`
- Process-local metric counters with optional `onMetric` emit hook
- Configurable cluster-safe `hashTag` mode

### Build / publish

- ESM + CJS dual publish via `tsup`
- 6 entry points: `.`, `/cache-components`, `/incremental`,
  `/client/redis`, `/client/ioredis`, `/ops`
- `arethetypeswrong` 100% green across `node10`, `node16` (CJS), `node16`
  (ESM), `bundler`
- `publint` clean
- 66 unit tests covering build-phase skip, SWR, abort, memory fallback,
  serialization, and both handlers end-to-end
