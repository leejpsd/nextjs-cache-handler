import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import {
  bufferToStream,
} from "../../src/cache-components/serialize.js";
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

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  delete process.env.NEXT_PHASE;
});
afterEach(() => {
  vi.useRealTimers();
});

function pair(sharedClient: MockRedisClient) {
  const events: MetricEvent[] = [];
  const a = createCacheComponentsHandler({
    client: () => sharedClient,
    abortTimeoutMs: 100,
    tagPubSub: true,
  });
  const b = createCacheComponentsHandler({
    client: () => sharedClient,
    abortTimeoutMs: 100,
    tagPubSub: true,
    onMetric: (e) => events.push(e),
  });
  return { a, b, events };
}

describe("cacheHandlers — tagPubSub push propagation", () => {
  it("instance B observes A's invalidation WITHOUT calling refreshTags", async () => {
    const client = new MockRedisClient();
    client.isOpen = true;
    const { a, b } = pair(client);

    // Establish B's subscription (lazy — first redis-gated op).
    await b.get("warm-up", []);
    await a.get("warm-up", []); // A subscribes too (publisher doesn't need it)

    await a.set("k", Promise.resolve(entry({ tags: ["posts"] })));
    vi.setSystemTime(new Date(T0 + 10));
    await a.updateTags(["posts"]); // soft — publishes on the inval channel

    // NO b.refreshTags() here — the push alone must inform B.
    const got = await b.get("k", []);
    expect(got).toBeDefined(); // soft = SWR serve...
    expect(await b.getExpiration(["posts"])).toBe(T0 + 10); // ...and B knows the timestamp
  });

  it("push updates never move a tag timestamp backwards", async () => {
    const client = new MockRedisClient();
    client.isOpen = true;
    const { a, b } = pair(client);
    await b.get("warm-up", []);

    vi.setSystemTime(new Date(T0 + 100));
    await a.updateTags(["posts"]);
    vi.setSystemTime(new Date(T0 + 50)); // out-of-order older publish
    await a.updateTags(["posts"]);

    expect(await b.getExpiration(["posts"])).toBe(T0 + 100);
  });

  it("clients without subscribe support disable pubsub once and keep working", async () => {
    const client = new MockRedisClient();
    client.isOpen = true;
    // Strip subscribe to emulate a Cluster client.
    (client as unknown as { subscribe?: unknown }).subscribe = undefined;
    const warns: string[] = [];
    const handler = createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
      tagPubSub: true,
      logger: {
        debug() {}, info() {},
        warn: (m) => warns.push(m),
        error() {},
      },
    });

    await handler.get("k", []);
    await handler.get("k", []);
    expect(warns.filter((w) => w.includes("tagPubSub unavailable")).length).toBe(1);

    // Polling path still works end to end.
    await handler.set("k", Promise.resolve(entry()));
    expect(await handler.get("k", [])).toBeDefined();
  });

  it("default (tagPubSub off) never subscribes", async () => {
    const client = new MockRedisClient();
    client.isOpen = true;
    const spy = vi.spyOn(client, "subscribe");
    const handler = createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
    });
    await handler.get("k", []);
    expect(spy).not.toHaveBeenCalled();
  });
});
