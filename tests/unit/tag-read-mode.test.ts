/**
 * `tagReadMode` (#31): "scan" (default) rebuilds a local tag mirror with a
 * namespace SCAN on every refreshTags(); "on-demand" skips the scan and reads
 * exactly the markers an entry depends on inside get() / getExpiration().
 *
 * Two handler instances share one mock Redis to stand in for two Next.js
 * servers behind a load balancer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bufferToStream } from "../../src/cache-components/serialize.js";
import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import type { CacheComponentsEntry, MetricEvent } from "../../src/types.js";

import { MockRedisClient } from "./_mock-client.js";

const T0 = 1_700_000_000_000;

function entry(overrides: Partial<CacheComponentsEntry> = {}): CacheComponentsEntry {
  return {
    value: bufferToStream(Buffer.from("html body")),
    tags: ["posts"],
    stale: 60,
    timestamp: T0,
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

let originalPhase: string | undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  originalPhase = process.env.NEXT_PHASE;
  delete process.env.NEXT_PHASE;
});
afterEach(() => {
  vi.useRealTimers();
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
});

function pair(
  mode?: "scan" | "on-demand",
  extra: { fallback?: "auto" | "never" } = {}
) {
  const client = new MockRedisClient();
  client.isOpen = true;
  const events: MetricEvent[] = [];
  const make = () =>
    createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
      onMetric: (e) => events.push(e),
      ...(mode ? { tagReadMode: mode } : {}),
      ...extra,
    });
  return { client, events, a: make(), b: make() };
}

describe("cacheHandlers — tagReadMode (#31)", () => {
  it("default (scan): refreshTags() SCANs the namespace", async () => {
    const { client, a } = pair();
    const scan = vi.spyOn(client, "scanIterator");
    await a.refreshTags();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("on-demand: refreshTags() does not SCAN", async () => {
    const { client, a } = pair("on-demand");
    const scan = vi.spyOn(client, "scanIterator");
    await a.refreshTags();
    expect(scan).not.toHaveBeenCalled();
  });

  it("on-demand: get() sees another instance's soft invalidation without refreshTags()", async () => {
    const { a, b } = pair("on-demand");
    await a.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await b.updateTags(["posts"], { expire: 30 });

    const got = await a.get("k", []);
    expect(got).toBeDefined();
    expect(got!.revalidate).toBe(-1); // served stale, background refresh requested
  });

  it("scan mode needs refreshTags() first to see the same invalidation", async () => {
    const { a, b } = pair("scan");
    await a.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await b.updateTags(["posts"], { expire: 30 });

    expect((await a.get("k", []))!.revalidate).toBe(60); // mirror not refreshed yet
    await a.refreshTags();
    expect((await a.get("k", []))!.revalidate).toBe(-1);
  });

  it("on-demand: the hard deadline of a soft invalidation is enforced on read", async () => {
    const { a, b } = pair("on-demand");
    await a.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await b.updateTags(["posts"], { expire: 30 });
    vi.setSystemTime(new Date(T0 + 10 + 31_000));
    expect(await a.get("k", [])).toBeUndefined();
  });

  it("on-demand: the route's soft tags passed to get() are read too", async () => {
    const { a, b } = pair("on-demand");
    await a.set("k", Promise.resolve(entry({ tags: [] })));
    vi.setSystemTime(new Date(T0 + 10));
    await b.updateTags(["_N_T_/blog"], { expire: 30 });
    const got = await a.get("k", ["_N_T_/blog"]);
    expect(got).toBeDefined();
    expect(got!.revalidate).toBe(-1);
  });

  it("on-demand: one MGET per get(), covering entry tags and soft tags", async () => {
    const { client, a, events } = pair("on-demand");
    await a.set("k", Promise.resolve(entry({ tags: ["posts", "authors"] })));
    const mget = vi.spyOn(client, "mGet");
    const scan = vi.spyOn(client, "scanIterator");
    await a.refreshTags();
    await a.get("k", ["_N_T_/blog"]);
    expect(scan).not.toHaveBeenCalled();
    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget.mock.calls[0]![0]).toHaveLength(3);
    expect(
      events.some(
        (e) =>
          e.type === "tag.expiration.read" &&
          e.meta?.source === "redis" &&
          e.meta?.op === "get"
      )
    ).toBe(true);
  });

  it("on-demand: get() with no tags at all does not touch the markers", async () => {
    const { client, a } = pair("on-demand");
    await a.set("k", Promise.resolve(entry({ tags: [] })));
    const mget = vi.spyOn(client, "mGet");
    expect(await a.get("k", [])).toBeDefined();
    expect(mget).not.toHaveBeenCalled();
  });

  it("on-demand: getExpiration() answers from Redis, not from a stale local mirror", async () => {
    const { a, b } = pair("on-demand");
    vi.setSystemTime(new Date(T0 + 10));
    await a.updateTags(["posts"], { expire: 30 }); // A's own mirror: soft, deadline T0+10+30s
    vi.setSystemTime(new Date(T0 + 20));
    await b.updateTags(["posts"]); // B: hard, deadline T0+20
    expect(await a.getExpiration(["posts"])).toBe(T0 + 20);
  });

  it("on-demand: getExpiration() returns 0 for tags nobody invalidated", async () => {
    const { a } = pair("on-demand");
    expect(await a.getExpiration(["never-touched"])).toBe(0);
  });

  it("on-demand: a failed tag read falls back to the local mirror (fallback: auto)", async () => {
    const { client, a, b } = pair("on-demand");
    await a.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await b.updateTags(["posts"], { expire: 30 });
    vi.spyOn(client, "mGet").mockRejectedValueOnce(new Error("boom"));
    const got = await a.get("k", []);
    expect(got).toBeDefined();
    // A never learned of B's invalidation on this read, so it serves the
    // entry as fresh instead of dropping it: the "auto" degradation.
    expect(got!.revalidate).toBe(60);
  });

  it("on-demand + fallback: 'never': a failed tag read is a miss", async () => {
    const { client, a, events } = pair("on-demand", { fallback: "never" });
    await a.set("k", Promise.resolve(entry()));
    vi.spyOn(client, "mGet").mockRejectedValueOnce(new Error("boom"));
    expect(await a.get("k", [])).toBeUndefined();
    expect(
      events.some(
        (e) => e.type === "cache.miss" && e.meta?.reason === "tag-read-failed"
      )
    ).toBe(true);
  });

  it("on-demand: this instance's own invalidation is still read-your-own-writes", async () => {
    const { a } = pair("on-demand");
    await a.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await a.updateTags(["posts"]); // hard: entry deleted and marker written
    expect(await a.get("k", [])).toBeUndefined();
  });

  it("same-millisecond soft then hard invalidation: the hard deadline wins", async () => {
    const { a, b } = pair("on-demand");
    vi.setSystemTime(new Date(T0 + 10));
    await a.updateTags(["posts"], { expire: 30 });
    await b.updateTags(["posts"]); // same ms, hard
    expect(await a.getExpiration(["posts"])).toBe(T0 + 10);
  });
});
