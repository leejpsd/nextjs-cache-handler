import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import { bufferToStream } from "../../src/cache-components/serialize.js";
import type { CacheComponentsEntry, MetricEvent } from "../../src/types.js";

import { MockRedisClient } from "./_mock-client.js";

const T0 = 1_700_000_000_000;

function entry(overrides: Partial<CacheComponentsEntry> = {}): CacheComponentsEntry {
  return {
    value: bufferToStream(Buffer.from("body")),
    tags: ["posts"],
    stale: 60,
    timestamp: T0,
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

function setup(opts: Record<string, unknown> = {}) {
  const client = new MockRedisClient();
  client.isOpen = true;
  const events: MetricEvent[] = [];
  const handler = createCacheComponentsHandler({
    client: () => client,
    abortTimeoutMs: 100,
    onMetric: (e) => events.push(e),
    ...opts,
  });
  return { client, events, handler };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  delete process.env.NEXT_PHASE;
  delete process.env.__NEXT_DEV_SERVER;
});
afterEach(() => {
  vi.useRealTimers();
});

// Upstream contract (verified against next@16.2.3/16.3.0
// dist/server/revalidation-utils.js and lib/cache-handlers/default.js):
//   updateTags(tags)                — durations UNDEFINED — HARD: entries with
//                                     the tag must never be served again
//                                     (updateTag(), single-arg revalidateTag).
//   updateTags(tags, { expire: N }) — SOFT: entries turn stale now, keep
//                                     serving while refreshing, hard-expire
//                                     N seconds later (Infinity = never).
describe("cacheHandlers — updateTags durations polarity (0.4.2)", () => {
  it("no durations (updateTag) is HARD: read-your-own-writes, get() misses", async () => {
    const { handler, events } = setup();
    await handler.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"]);

    expect(await handler.get("k", [])).toBeUndefined();
    expect(events.some((e) => e.type === "tag.invalidate.hard")).toBe(true);
  });

  it("{ expire: 0 } stays HARD", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 0 });
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("{ expire: N } is SOFT: serves with truthful timestamp and revalidate: -1", async () => {
    const { handler, events } = setup();
    await handler.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 3600 });

    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    // Truthful timestamp (no backdating) + revalidate: -1 mirrors the
    // built-in handler's stale signaling and never crosses `expire`.
    expect(got!.timestamp).toBe(T0);
    expect(got!.revalidate).toBe(-1);
    expect(events.some((e) => e.type === "cache.stale")).toBe(true);
    expect(events.some((e) => e.type === "cache.miss")).toBe(false);
  });

  it("SOFT entries hard-expire durations.expire seconds after the invalidation", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.resolve(entry({ expire: 100_000 })));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 30 });

    vi.setSystemTime(new Date(T0 + 10 + 29_000));
    expect(await handler.get("k", [])).toBeDefined(); // still within window

    vi.setSystemTime(new Date(T0 + 10 + 31_000));
    expect(await handler.get("k", [])).toBeUndefined(); // past the deadline
  });

  it("{ expire: Infinity } (max profile) never hard-expires", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.resolve(entry({ expire: 10_000_000 })));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: Infinity });

    vi.setSystemTime(new Date(T0 + 10 + 86_400_000)); // +1 day
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    expect(got!.revalidate).toBe(-1);
  });

  it("{ expire: undefined } (custom profile without expire) is SOFT, not hard", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: undefined });
    expect(await handler.get("k", [])).toBeDefined();
  });

  it("SOFT serves stale even with staleWhileRevalidate: false (upstream-mandated)", async () => {
    const { handler } = setup({ staleWhileRevalidate: false });
    await handler.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 3600 });
    expect(await handler.get("k", [])).toBeDefined();
  });

  it("getExpiration reports the hard deadline, not the stale stamp", async () => {
    const { handler } = setup();
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 30 });
    // default.js getExpiration returns `entry.expired || 0` — the deadline.
    expect(await handler.getExpiration(["posts"])).toBe(T0 + 10 + 30_000);

    await handler.updateTags(["news"]); // hard → deadline is "now"
    expect(await handler.getExpiration(["news"])).toBe(T0 + 10);

    await handler.updateTags(["evergreen"], { expire: Infinity });
    expect(await handler.getExpiration(["evergreen"])).toBe(0); // never hard-expires
  });
});

describe("cacheHandlers — marker wire format compatibility (0.4.2)", () => {
  it("legacy plain-number markers (0.4.1 and earlier) are treated as hard-at-timestamp", async () => {
    const { handler, client } = setup();
    await handler.set("k", Promise.resolve(entry()));
    // A 0.4.1 instance wrote a bare timestamp marker after our entry.
    const markerKey = [...client.kv.keys()].find((k) => k.includes("tag-expiration"));
    // Ensure key shape assumption holds even before any marker exists.
    const prefix = markerKey ?? "next-cache:tag-expiration:unversioned:posts";
    client.kv.set(prefix.replace(/[^:]+$/, "posts"), String(T0 + 10));

    vi.setSystemTime(new Date(T0 + 20));
    await handler.refreshTags();
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("new markers parse as <stale>|<expired> and old readers would still parseInt the stale part", async () => {
    const { handler, client } = setup();
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 30 });
    const marker = [...client.kv.entries()].find(([k]) => k.includes("tag-expiration"));
    expect(marker).toBeDefined();
    const value = marker![1];
    expect(value).toBe(`${T0 + 10}|${T0 + 10 + 30_000}`);
    // 0.4.1 readers do Number.parseInt(v, 10) — must yield the stale stamp.
    expect(Number.parseInt(value, 10)).toBe(T0 + 10);
  });

  it("pub/sub payload carries the deadline; legacy {t, ts} payloads mean soft-forever", async () => {
    const client = new MockRedisClient();
    client.isOpen = true;
    const published: string[] = [];
    (client as unknown as { publish: unknown }).publish = async (_ch: string, msg: string) => {
      published.push(msg);
      return 1;
    };
    let subscribed: ((msg: string) => void) | undefined;
    (client as unknown as { subscribe: unknown }).subscribe = async (
      _ch: string,
      cb: (m: string) => void
    ) => {
      subscribed = cb;
      return async () => {};
    };
    const handler = createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
      tagPubSub: true,
    });

    await handler.set("k", Promise.resolve(entry()));
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["posts"], { expire: 30 });
    const payload = JSON.parse(published.at(-1)!) as { t: string[]; ts: number; e?: number };
    expect(payload.ts).toBe(T0 + 10);
    expect(payload.e).toBe(T0 + 10 + 30_000);

    // Legacy publisher (0.4.1): {t, ts} only → soft with no deadline.
    subscribed?.(JSON.stringify({ t: ["legacy-tag"], ts: T0 + 20 }));
    await handler.set("k2", Promise.resolve(entry({ tags: ["legacy-tag"], timestamp: T0 })));
    vi.setSystemTime(new Date(T0 + 30));
    expect(await handler.get("k2", [])).toBeDefined(); // served stale, not missed
  });
});

describe("cacheHandlers — expire: 0 entries are not persisted in production (0.4.2)", () => {
  it("skips the write entirely (mirrors 16.3 built-in handler)", async () => {
    const { handler, client, events } = setup();
    await handler.set("k", Promise.resolve(entry({ expire: 0 })));
    expect([...client.kv.keys()].some((k) => k.includes("entry"))).toBe(false);
    expect(events.some((e) => e.type === "cache.set.skipped")).toBe(true);
  });

  it("still persists in dev (__NEXT_DEV_SERVER)", async () => {
    process.env.__NEXT_DEV_SERVER = "1";
    const { handler, client } = setup();
    await handler.set("k", Promise.resolve(entry({ expire: 0 })));
    expect([...client.kv.keys()].some((k) => k.includes("entry"))).toBe(true);
  });
});
