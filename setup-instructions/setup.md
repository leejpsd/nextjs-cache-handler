# Set up @leejpsd/nextjs-cache-handler for a Next.js project

## Overview

This setup file wires Redis caching into a self-hosted Next.js 15/16 app
using `@leejpsd/nextjs-cache-handler`: it detects the Next.js version,
installs the package and a Redis client, generates the handler wrapper
files, patches `next.config`, and verifies a cache round-trip.

The workflow includes:

- Detecting the Next.js version and router setup from `package.json`
- Installing `@leejpsd/nextjs-cache-handler` (>= 0.3.3) plus `redis` or `ioredis`
- Generating `cache-incremental.cjs` (and `cache-components.cjs` on Next 16)
- Patching `next.config.(js|ts|mjs)` — always show the diff and get approval
- Verifying MISS → HIT against a local or provided Redis
- Adding the project rules block to the AI tool's rules file

## Parameters

- redis_url (optional): Redis connection string. If not provided, use
  `redis://127.0.0.1:6379` for local verification and tell the user to set
  `REDIS_URL` in their deployment environment.
- deployment_version_source (optional): how the app derives
  `DEPLOYMENT_VERSION` (git SHA, CI build id). Default: `git rev-parse
  --short HEAD`; if the directory is not a git repo, fall back to a fixed
  value the user chooses (any stable per-deploy string works).

Constraints:

- You MUST NOT use this package for Vercel-hosted deployments — tell the
  user Vercel's managed cache already covers them, and stop.
- You MUST detect the Next.js version before choosing which handlers to wire.
- You MUST show the `next.config` diff and get explicit approval before
  writing it — this file frequently contains user customizations — unless
  the user has already given blanket approval for changes in this project.
- You MUST NOT print or commit secrets (Redis passwords, URLs with auth).
- You MUST install version >= 0.3.3 (earlier versions have an incomplete
  soft-invalidation path).

## Steps

### Step 1: Detect the project

Read `package.json`. Determine:

- `dependencies.next` version → **15.x** (singular handler only) or
  **>= 16.1.5** (both handlers). If `< 15.0.0`, STOP: unsupported
  (peer range is `>=15.0.0 <17`).
- Which Redis client is already installed (`redis` or `ioredis`); if neither,
  default to `redis` unless the user needs Cluster or Sentinel (those
  require `ioredis`).

**Error handling:**

| Symptom | Cause | Resolution |
|---------|-------|------------|
| No `next` in dependencies | Not a Next.js project | Ask the user for the correct project directory |
| Next < 15 | Unsupported | Suggest upgrading Next, or stop |

### Step 2: Install

```bash
npm install @leejpsd/nextjs-cache-handler redis
# or, when Cluster/Sentinel is needed:
npm install @leejpsd/nextjs-cache-handler ioredis
```

**Success:** exit code 0, no peer-dependency conflicts (the package supports
`next >=15.0.0 <17`).

### Step 3: Generate wrapper files

Create `cache-incremental.cjs` in the project root (ALL versions):

```js
const { createIncrementalCacheHandler } = require("@leejpsd/nextjs-cache-handler/incremental");
module.exports = createIncrementalCacheHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: () => process.env.DEPLOYMENT_VERSION,
});
```

On **Next 16** also create `cache-components.cjs`:

```js
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");
module.exports = createCacheComponentsHandler({
  client: { type: "redis", url: process.env.REDIS_URL },
  buildNamespace: () => process.env.DEPLOYMENT_VERSION,
});
```

Use `{ type: "ioredis", ... }` / `cluster` / `sentinel` variants when the
user's infrastructure requires them (Cluster additionally needs
`hashTag: true` in the handler options).

### Step 4: Patch next.config (approval required)

If no `next.config.(js|ts|mjs)` exists, CREATE `next.config.js` with just
these keys. If one exists, merge the keys into it — do not replace the
file. Show the diff and get approval first, unless the user already gave
blanket approval for this project's files:

```ts
cacheHandler: require.resolve("./cache-incremental.cjs"),
cacheHandlers: { default: require.resolve("./cache-components.cjs") }, // Next 16 only
cacheComponents: true,   // Next 16 only — see the warning below before enabling
cacheMaxMemorySize: 0,   // required for multi-instance correctness
```

**`cacheComponents: true` decision rule**: enabling it is a MODE SWITCH, not
a free feature — it is incompatible with route segment configs like
`export const revalidate` / `export const dynamic` and will FAIL THE BUILD
of apps that use them. Enable it only when the app already uses (or is
migrating to) `'use cache'`. When in doubt, wire `cacheHandlers` but leave
`cacheComponents` off and tell the user how to enable it later.

Show the diff, get approval, then write.

**Error handling:**

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Config is ESM (`next.config.mjs`) | `require.resolve` unavailable | Use `import { createRequire } from "module"; const require = createRequire(import.meta.url);` at the top |
| `cacheHandler` already set | Another handler in use | Show both, ask the user which should win |

### Step 5: Environment

Tell the user to provide in every runtime environment (NOT build-only):

- `REDIS_URL` — e.g. `rediss://...` for TLS/managed Redis
- `DEPLOYMENT_VERSION` — per-deploy value (git SHA); in Docker it MUST be
  declared in the **runner** stage

Append both to `.env.example` if the project has one.

### Step 6: Verify

With a local Redis (`docker run -d -p 6379:6379 redis:7-alpine` or a native
`redis-server`), run (pick a free port explicitly — do not assume 3000):

```bash
REDIS_URL=redis://127.0.0.1:6379 DEPLOYMENT_VERSION=setup-verify npm run build
REDIS_URL=redis://127.0.0.1:6379 DEPLOYMENT_VERSION=setup-verify npm run start -- -p 3777 &
# wait for readiness before curling:
for i in $(seq 1 30); do curl -sf http://127.0.0.1:3777/ >/dev/null && break; sleep 1; done
```

Check the `x-nextjs-cache` header on an ISR/static page. **Two valid
outcomes**: build-time-prerendered pages are often served as `HIT` from the
very first request; on-demand pages show `MISS` then `HIT`. Either way,
confirm keys exist with `redis-cli --scan --pattern 'next-incremental:*'`
(never use `KEYS` — it blocks Redis).

The strongest proof is a full round-trip: delete the page's entry key with
the server running, then request twice — expect `MISS` then `HIT` and the
key to REAPPEAR in Redis (proves both read and write paths). Kill the
server afterwards and verify the port is free.

**Error handling:**

| Symptom | Cause | Resolution |
|---------|-------|------------|
| `ECONNREFUSED` during build | Expected — build phase skips Redis | Ignore unless the build itself fails |
| No `next-*` keys after requests | Handler not loaded | Check `next.config` paths resolve; check server logs for `[next-cache]` lines |
| `CROSSSLOT` errors | Redis Cluster without `hashTag: true` | Add the option in both wrappers |

### Step 7: Add the agent rules block

Identify the AI tool's rules file (CLAUDE.md / AGENTS.md / .cursor/rules/)
and append the contents of:

https://raw.githubusercontent.com/leejpsd/nextjs-cache-handler/main/rules/nextjs-cache-rules.md

End by telling the user: "Redis caching is wired. Set REDIS_URL and
DEPLOYMENT_VERSION in your deployment environment, and see the
nextjs-redis-cache skill for invalidation semantics and production
checklist."
