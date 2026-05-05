/**
 * Stale-While-Revalidate decision logic for the cacheHandlers (plural)
 * interface.
 *
 * Next.js 16 distinguishes three time axes for an entry, all expressed as
 * seconds offset from `timestamp` (ms epoch):
 *
 *   timestamp ───── revalidate ───── stale ───── expire ─────►
 *       │              │                │            │
 *      fresh          SWR window       SWR window    hard
 *       │              (background      ends         miss
 *       │               refresh)
 *
 * The reference handler in next-redis-cache-demo collapsed this into a single
 * `revalidate` check, returning `undefined` (cache miss) the moment the entry
 * crossed `revalidate`. That defeats SWR — every user past the revalidate
 * boundary pays the full origin cost instead of getting an instant stale read.
 *
 * The corrected partition:
 *   - age <= revalidate * 1000 → "fresh"
 *   - revalidate*1000 < age <= expire*1000 → "stale" (still served, refresh
 *     happens in background per Next.js' own scheduling)
 *   - age > expire*1000 → "expired" (true miss, evict the entry)
 *
 * This module is pure logic. It does not touch Redis. The handler's `get`
 * threads the entry through `partitionEntry` and decides what to return.
 */

import type { CacheComponentsEntry } from "../types.js";

export type EntryFreshness = "fresh" | "stale" | "expired";

export interface PartitionResult {
  freshness: EntryFreshness;
  /** Age in ms since the entry's timestamp. */
  ageMs: number;
}

const SECOND_MS = 1000;

/**
 * Classify an entry into one of the three freshness buckets.
 *
 * Edge cases:
 *   - Negative age (clock skew where timestamp is in the future): treat as fresh.
 *     The entry was clearly just written; we don't punish the read for a 2s
 *     clock drift between the writer and reader instances.
 *   - expire === 0: per Next.js' "no hard expire" sentinel. We map it to a
 *     practical upper bound (one year) so the partition still works. This
 *     matches the TTL-fallback behavior of the reference handler.
 *   - revalidate >= expire: degenerate config. We honor revalidate as the
 *     fresh→stale boundary and clamp expire upward when it's smaller.
 */
export function partitionEntry(
  entry: Pick<CacheComponentsEntry, "timestamp" | "revalidate" | "expire">,
  now: number = Date.now()
): PartitionResult {
  const ageMs = now - entry.timestamp;

  if (ageMs < 0) {
    return { freshness: "fresh", ageMs };
  }

  const revalidateMs = Math.max(0, entry.revalidate) * SECOND_MS;
  const rawExpireMs = entry.expire === 0 ? Number.POSITIVE_INFINITY : Math.max(0, entry.expire) * SECOND_MS;
  const expireMs = Math.max(rawExpireMs, revalidateMs);

  if (ageMs <= revalidateMs) {
    return { freshness: "fresh", ageMs };
  }
  if (ageMs <= expireMs) {
    return { freshness: "stale", ageMs };
  }
  return { freshness: "expired", ageMs };
}

/**
 * Decide whether to honor a `staleWhileRevalidate` config knob. When the user
 * disables SWR, "stale" entries are treated as expired (preserving v0
 * behavior).
 */
export function shouldServeStale(
  result: PartitionResult,
  staleWhileRevalidate: boolean
): boolean {
  return result.freshness === "fresh" || (result.freshness === "stale" && staleWhileRevalidate);
}
