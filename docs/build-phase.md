# Build-phase skip

This document explains the `phase-production-build` short-circuit and why
it's table-stakes for any Next.js 16 cache handler.

## The problem

Next.js 16 prerenders pages with `'use cache'` directives during
`next build`. The build process calls `cacheHandlers.get` and
`cacheHandlers.set` against any handler you've registered. If your
handler connects to Redis unconditionally at module import, you get one
of two failure modes:

### Failure mode 1: ECONNREFUSED at build time

```
$ docker build -t my-app .
...
> next build
> redis-handler.cjs is loaded
> Redis client error: connect ECONNREFUSED 127.0.0.1:6379
> Error: Build failed
```

The Docker `RUN npm run build` step has no Redis. CI pipelines have no
Redis. Local laptops without `docker compose up` have no Redis.

### Failure mode 2: production secrets leaked into images

To work around mode 1, teams sometimes inject the production
`REDIS_URL` into the build environment. That secret then ends up in
build logs, cached layers, and intermediate images. Worse, the build
*does* connect to production Redis and writes prerender entries with
`buildId` in the key — entries that will be junk for runtime requests.

### The PR #207 precedent

PR [`fortedigital/nextjs-cache-handler#207`](https://github.com/fortedigital/nextjs-cache-handler/pull/207),
filed 2026-03-13, attempted to add `cacheHandlers` support. The
maintainer's review on 2026-03-27 rejected it specifically for this
reason:

> *"This does not really solve the problem of handler saving to redis at
> built time. It only causes failures, the cache handler is still
> registered, still calls redis methods."*

> *"Please check how PHASE_PRODUCTION_BUILD is used in cache-handler.ts
> to properly implement skipping redis calls at built time."*

The PR has been stalled for 3+ months as of this writing.

## The fix

Next.js sets `process.env.NEXT_PHASE` to `phase-production-build` during
the prerender pass. Reading it at every handler entry point and
short-circuiting Redis calls is the correct response.

```ts
// src/shared/build-phase.ts

const PHASE_PRODUCTION_BUILD = "phase-production-build";

export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

export function shouldUseRedis(opts: {
  fallback?: "auto" | "always" | "never";
  isBuildPhase?: () => boolean;
}): boolean {
  if (opts.fallback === "always") return false;
  const detector = opts.isBuildPhase ?? isBuildPhase;
  if (detector()) return false;
  return true;
}
```

Every handler method (`get`, `set`, `refreshTags`, `getExpiration`,
`updateTags`, `revalidateTag`) calls `shouldUseRedis()` before touching
the connection manager. In build phase, all calls route to the in-memory
fallback instead. Build completes; production runtime is unaffected.

## Verification

Two regression tests in this repo guarantee the fix doesn't drift:

```ts
// tests/unit/build-phase.test.ts
it("shouldUseRedis returns false during build phase (root cause of PR #207 ECONNREFUSED)", () => {
  process.env.NEXT_PHASE = "phase-production-build";
  expect(shouldUseRedis({ fallback: "auto" })).toBe(false);
});
```

```ts
// tests/unit/cache-components.test.ts
it("set() skips Redis entirely during NEXT_PHASE=phase-production-build", async () => {
  process.env.NEXT_PHASE = "phase-production-build";
  const setSpy = vi.spyOn(client, "set");
  await handler.set("k", Promise.resolve(makeEntry()));
  expect(setSpy).not.toHaveBeenCalled();
});
```

Plus a real-world dogfood: the next-redis-cache-demo project's
`USE_LIBRARY_HANDLER=true npm run build` succeeds with `REDIS_URL`
pointing at an unreachable host.

## Multi-stage Dockerfile

If you also use `BUILD_NAMESPACE` for deployment isolation (recommended,
see [`docs/architecture.md`](./architecture.md)), make sure
`DEPLOYMENT_VERSION` is **re-declared in the runner stage**, not just
the builder. Multi-stage builds don't inherit ENV across stages:

```dockerfile
# builder
FROM node:22-alpine AS builder
ARG DEPLOYMENT_VERSION
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build  # build phase — Redis is skipped

# runner — IMPORTANT: re-declare ARG/ENV
FROM node:22-alpine AS runner
ARG DEPLOYMENT_VERSION=dev-build
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
ENV GIT_HASH=$DEPLOYMENT_VERSION
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
```

Without the re-declaration, your runtime sees `DEPLOYMENT_VERSION=undefined`,
the namespace falls back to `"unversioned"`, and old entries from your
last deploy remain reachable in Redis — exactly the failure mode that
caused the static-chunk-404 incident in the reference implementation.
