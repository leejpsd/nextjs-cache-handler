/**
 * Detect whether Next.js is in the production build phase.
 *
 * During `next build` (or `next start --build`), Next pre-renders pages with
 * `'use cache'` directives, which means it calls `cacheHandlers.get` / `.set`
 * before any runtime infrastructure exists. Connecting to Redis in this phase
 * blows up the build with ECONNREFUSED.
 *
 * This is the same root cause that left `@fortedigital/nextjs-cache-handler`
 * PR #207 stalled for 3+ months — the maintainer's review explicitly demanded
 * `PHASE_PRODUCTION_BUILD` handling.
 *
 * The constant value comes from `next/constants`:
 *   PHASE_PRODUCTION_BUILD = 'phase-production-build'
 *
 * We intentionally read process.env at call time (not import time) so tests
 * and apps that set NEXT_PHASE late still observe the change.
 */
const PHASE_PRODUCTION_BUILD = "phase-production-build";

export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

/**
 * Decide whether to attempt a Redis connection given the configured fallback
 * strategy. Used as the gate at the top of every handler method.
 *
 * Returns `false` ⇒ skip Redis entirely, route through the in-memory fallback
 * Returns `true`  ⇒ proceed with the configured client
 */
export function shouldUseRedis(opts: {
  fallback?: "auto" | "always" | "never";
  isBuildPhase?: () => boolean;
}): boolean {
  if (opts.fallback === "always") return false;
  const detector = opts.isBuildPhase ?? isBuildPhase;
  if (detector()) return false;
  return true;
}
