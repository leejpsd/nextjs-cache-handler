import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bufferToStream,
  readStreamFully,
} from "../../src/cache-components/serialize.js";
import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import type {
  CacheComponentsEntry,
  MetricEvent,
} from "../../src/types.js";

import { MockRedisClient } from "./_mock-client.js";

const T0 = 1_700_000_000_000;

function makeEntry(overrides: Partial<CacheComponentsEntry> = {}): CacheComponentsEntry {
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

function setup(opts: { delayMs?: number; failNext?: number } = {}) {
  const events: MetricEvent[] = [];
  const client = new MockRedisClient(opts);
  client.isOpen = true; // skip real connect path in unit tests
  const handler = createCacheComponentsHandler({
    client: () => client,
    abortTimeoutMs: 100,
    onMetric: (e) => events.push(e),
  });
  return { handler, client, events };
}

describe("cacheHandlers — get/set round-trip", () => {
  it("set followed by get returns equivalent entry", async () => {
    const { handler, client } = setup();
    await handler.set("key1", Promise.resolve(makeEntry()));
    expect(client.kv.size).toBeGreaterThan(0);

    const got = await handler.get("key1", []);
    expect(got).toBeDefined();
    const buf = await readStreamFully(got!.value);
    expect(buf.toString("utf8")).toBe("html body");
    expect(got!.tags).toEqual(["posts"]);
    expect(got!.timestamp).toBe(T0);
  });

  it("get returns undefined for unknown key", async () => {
    const { handler } = setup();
    const got = await handler.get("missing", []);
    expect(got).toBeUndefined();
  });

  it("get returns undefined when entry is hard-expired", async () => {
    const { handler, client } = setup();
    await handler.set("k", Promise.resolve(makeEntry({ expire: 1, revalidate: 1 })));
    expect(client.kv.size).toBeGreaterThan(0);
    vi.setSystemTime(new Date(T0 + 5_000));
    const got = await handler.get("k", []);
    expect(got).toBeUndefined();
  });

  it("get returns stale entry within SWR window (default behavior)", async () => {
    const { handler, events } = setup();
    await handler.set("k", Promise.resolve(makeEntry({ revalidate: 1, expire: 60 })));
    vi.setSystemTime(new Date(T0 + 10_000));
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    expect(events.some((e) => e.type === "cache.stale")).toBe(true);
  });

  it("staleWhileRevalidate=false treats stale as miss", async () => {
    const events: MetricEvent[] = [];
    const client = new MockRedisClient();
    client.isOpen = true;
    const handler = createCacheComponentsHandler({
      client: () => client,
      staleWhileRevalidate: false,
      onMetric: (e) => events.push(e),
    });
    await handler.set("k", Promise.resolve(makeEntry({ revalidate: 1, expire: 60 })));
    vi.setSystemTime(new Date(T0 + 10_000));
    const got = await handler.get("k", []);
    expect(got).toBeUndefined();
  });

  it("set with empty tags uses simple SET (no Lua)", async () => {
    const { handler, client } = setup();
    const evalSpy = vi.spyOn(client, "eval");
    const evalShaSpy = vi.spyOn(client, "evalSha");
    await handler.set("k", Promise.resolve(makeEntry({ tags: [] })));
    expect(evalSpy).not.toHaveBeenCalled();
    expect(evalShaSpy).not.toHaveBeenCalled();
    expect(client.kv.size).toBe(1);
  });

  it("set with tags goes through Lua atomicity script", async () => {
    const { handler, client } = setup();
    await handler.set("k", Promise.resolve(makeEntry({ tags: ["a", "b"] })));
    // Tag sets exist atomically with the entry.
    const tagSets = [...client.sets.entries()];
    expect(tagSets.length).toBe(2);
    for (const [, members] of tagSets) {
      expect(members.size).toBe(1);
    }
  });
});

describe("cacheHandlers — error policy (spec §6)", () => {
  it("get() returns undefined instead of throwing on Redis failure", async () => {
    const { handler } = setup({ failNext: 1 });
    const got = await handler.get("k", []);
    expect(got).toBeUndefined();
  });

  it("set() does not throw on Redis failure (best-effort)", async () => {
    const { handler, events } = setup({ failNext: 1 });
    await expect(
      handler.set("k", Promise.resolve(makeEntry()))
    ).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "cache.set.failed")).toBe(true);
  });

  it("updateTags() with hard expire propagates errors", async () => {
    const { handler } = setup({ failNext: 1 });
    await expect(
      handler.updateTags(["t"], { expire: 0 })
    ).rejects.toBeTruthy();
  });

  it("updateTags() soft path swallows errors", async () => {
    const { handler } = setup({ failNext: 1 });
    await expect(handler.updateTags(["t"])).resolves.toBeUndefined();
  });

  it("set() discards entries when stream errors mid-read", async () => {
    const { handler, events, client } = setup();
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("network drop"));
      },
    });
    await handler.set(
      "k",
      Promise.resolve(makeEntry({ value: failingStream }))
    );
    expect(client.kv.size).toBe(0);
    expect(events.some((e) => e.type === "cache.set.failed")).toBe(true);
  });
});

describe("cacheHandlers — build phase skip (PR #207 regression)", () => {
  it("set() skips Redis entirely during NEXT_PHASE=phase-production-build", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    const { handler, client, events } = setup();
    const setSpy = vi.spyOn(client, "set");
    await handler.set("k", Promise.resolve(makeEntry()));
    expect(setSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "build_phase.skip")).toBe(true);
  });

  it("get() during build phase falls through to memory fallback", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    const { handler } = setup();
    await handler.set("k", Promise.resolve(makeEntry()));
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
  });
});

describe("cacheHandlers — soft tag freshness (spec §2.3)", () => {
  it("get() returns undefined when a soft tag was invalidated after entry timestamp", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.resolve(makeEntry()));
    // Simulate revalidatePath('/blog') firing after the entry was written.
    vi.setSystemTime(new Date(T0 + 10));
    await handler.updateTags(["_N_T_/blog"]);
    const got = await handler.get("k", ["_N_T_/blog"]);
    expect(got).toBeUndefined();
  });

  it("get() still returns entry when soft tag invalidation predates the entry", async () => {
    const { handler } = setup();
    vi.setSystemTime(new Date(T0));
    await handler.updateTags(["_N_T_/old"]);
    vi.setSystemTime(new Date(T0 + 1_000));
    await handler.set(
      "k",
      Promise.resolve(makeEntry({ timestamp: T0 + 1_000 }))
    );
    const got = await handler.get("k", ["_N_T_/old"]);
    expect(got).toBeDefined();
  });
});

describe("cacheHandlers — getExpiration (spec §2.3)", () => {
  it("returns 0 for never-invalidated tags", async () => {
    const { handler } = setup();
    expect(await handler.getExpiration(["unseen"])).toBe(0);
  });

  it("returns max timestamp across provided tags", async () => {
    const { handler } = setup();
    vi.setSystemTime(new Date(T0));
    await handler.updateTags(["a"]);
    vi.setSystemTime(new Date(T0 + 5_000));
    await handler.updateTags(["b"]);
    expect(await handler.getExpiration(["a", "b"])).toBe(T0 + 5_000);
  });

  it("empty tags array returns 0", async () => {
    const { handler } = setup();
    expect(await handler.getExpiration([])).toBe(0);
  });
});

describe("cacheHandlers — updateTags hard expire", () => {
  it("removes matching entries from cache (Lua revalidateHard)", async () => {
    const { handler, client } = setup();
    await handler.set("k1", Promise.resolve(makeEntry({ tags: ["posts"] })));
    await handler.set("k2", Promise.resolve(makeEntry({ tags: ["posts"] })));
    expect(client.kv.size).toBeGreaterThanOrEqual(2);

    await handler.updateTags(["posts"], { expire: 0 });

    // After hard expire, the tag set is gone and entries deleted (matching
    // Lua revalidate-hard behavior). Marker remains.
    const remaining = [...client.kv.keys()].filter((k) =>
      k.includes("entry:")
    );
    expect(remaining.length).toBe(0);
  });
});
