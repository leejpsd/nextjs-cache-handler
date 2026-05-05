import { describe, expect, it } from "vitest";

import { partitionEntry, shouldServeStale } from "../../src/cache-components/swr.js";

const T0 = 1_700_000_000_000;

function entry(overrides: Partial<{ timestamp: number; revalidate: number; expire: number }> = {}) {
  return {
    timestamp: T0,
    revalidate: 60,
    expire: 3600,
    ...overrides,
  };
}

describe("partitionEntry — 3-axis SWR", () => {
  it("classifies fresh when age <= revalidate", () => {
    const r = partitionEntry(entry(), T0 + 30_000);
    expect(r.freshness).toBe("fresh");
  });

  it("classifies stale when revalidate < age <= expire", () => {
    const r = partitionEntry(entry(), T0 + 120_000);
    expect(r.freshness).toBe("stale");
  });

  it("classifies expired when age > expire", () => {
    const r = partitionEntry(entry(), T0 + 4_000_000);
    expect(r.freshness).toBe("expired");
  });

  it("treats clock skew (negative age) as fresh", () => {
    // Reader clock is behind writer's. Don't punish the read.
    const r = partitionEntry(entry(), T0 - 5000);
    expect(r.freshness).toBe("fresh");
    expect(r.ageMs).toBeLessThan(0);
  });

  it("expire=0 maps to never-hard-expire", () => {
    // Per spec §4: cacheLife({expire: Infinity}) is the "never" sentinel.
    // The handler stores Infinity as 0 in some serializations, so 0 must be
    // treated as the same thing.
    const r = partitionEntry(entry({ expire: 0 }), T0 + 10_000_000_000);
    // 10^10 ms = ~317 years — should still be "stale", not expired.
    expect(r.freshness).toBe("stale");
  });

  it("clamps expire to revalidate when expire < revalidate (degenerate)", () => {
    // Degenerate config: expire (50s) < revalidate (100s). Without the clamp
    // an entry would be considered "expired" the moment it's written.
    // Partition clamps expireMs upward to revalidateMs so the entry is at
    // worst classified as `stale` (and the surrounding code can decide whether
    // to keep serving it). With age=50s, the entry is still inside revalidate.
    const r = partitionEntry(entry({ revalidate: 100, expire: 50 }), T0 + 50_000);
    expect(r.freshness).toBe("fresh");
  });

  it("degenerate (expire < revalidate) classifies as expired past the clamp", () => {
    // The clamp keeps expireMs >= revalidateMs but does not extend it further.
    // So past revalidate (clamp-equal), we go straight to expired. The clamp's
    // job is to prevent the entry from being `expired` while still inside the
    // fresh window — not to manufacture a stale window.
    const r = partitionEntry(entry({ revalidate: 100, expire: 50 }), T0 + 100_001);
    expect(r.freshness).toBe("expired");
  });
});

describe("shouldServeStale", () => {
  it("serves fresh entries unconditionally", () => {
    expect(shouldServeStale({ freshness: "fresh", ageMs: 0 }, true)).toBe(true);
    expect(shouldServeStale({ freshness: "fresh", ageMs: 0 }, false)).toBe(true);
  });

  it("serves stale only when SWR is enabled", () => {
    expect(shouldServeStale({ freshness: "stale", ageMs: 100 }, true)).toBe(true);
    expect(shouldServeStale({ freshness: "stale", ageMs: 100 }, false)).toBe(false);
  });

  it("never serves expired", () => {
    expect(shouldServeStale({ freshness: "expired", ageMs: 999 }, true)).toBe(false);
    expect(shouldServeStale({ freshness: "expired", ageMs: 999 }, false)).toBe(false);
  });
});
