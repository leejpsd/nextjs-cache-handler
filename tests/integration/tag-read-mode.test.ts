/**
 * `tagReadMode: "on-demand"` (#31) against a real Redis: two handler
 * instances share one Redis, one invalidates, the other must see it without
 * running `refreshTags()` (which no longer scans in this mode).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import type { CacheComponentsEntry, RedisClientLike } from "../../src/types.js";
import { adaptRedisV5, createRedisV5Client } from "../../src/shared/client/adapter-redis.js";
import {
  adaptIoredis,
  createIoredisClient,
} from "../../src/shared/client/adapter-ioredis.js";

import { bufferToStream, flushAll, getRedisUrl, isRedisReachable } from "./_redis-helpers.js";

const NAMESPACE = "it-tag-read-mode";

function makeEntry(overrides: Partial<CacheComponentsEntry> = {}): CacheComponentsEntry {
  return {
    value: bufferToStream(Buffer.from("payload")),
    tags: ["posts"],
    stale: 60,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

let reachable = true;
let probed = false;

beforeAll(async () => {
  reachable = await isRedisReachable();
  probed = true;
});

const adapters = [
  {
    name: "redis@5",
    build: (): RedisClientLike =>
      adaptRedisV5(createRedisV5Client({ type: "redis", url: getRedisUrl() })),
  },
  {
    name: "ioredis",
    build: (): RedisClientLike =>
      adaptIoredis(createIoredisClient({ type: "ioredis", url: getRedisUrl() })),
  },
];

for (const adapter of adapters) {
  describe(`integration: tagReadMode "on-demand" over ${adapter.name}`, () => {
    let client: RedisClientLike;
    let a: ReturnType<typeof createCacheComponentsHandler>;
    let b: ReturnType<typeof createCacheComponentsHandler>;

    beforeAll(async () => {
      if (!probed) reachable = await isRedisReachable();
      if (!reachable) return;
      client = adapter.build();
      if (!client.isOpen) await client.connect();
      const make = () =>
        createCacheComponentsHandler({
          client: () => client,
          keyPrefix: "next-cache:",
          buildNamespace: () => NAMESPACE,
          abortTimeoutMs: 3000,
          tagReadMode: "on-demand",
        });
      a = make();
      b = make();
    });

    beforeEach(async () => {
      if (!reachable) return;
      await flushAll(client);
    });

    afterAll(async () => {
      if (!reachable || !client) return;
      await flushAll(client);
    });

    it.skipIf(!reachable)("refreshTags() issues no SCAN", async () => {
      const scan = vi.spyOn(client, "scanIterator");
      await a.refreshTags();
      expect(scan).not.toHaveBeenCalled();
      scan.mockRestore();
    });

    it.skipIf(!reachable)(
      "a soft invalidation on B is visible to A's next get() without refreshTags()",
      async () => {
        await a.set("page", Promise.resolve(makeEntry({ timestamp: Date.now() - 50 })));
        await b.updateTags(["posts"], { expire: 3600 });
        const got = await a.get("page", []);
        expect(got).toBeDefined();
        expect(got!.revalidate).toBe(-1);
      }
    );

    it.skipIf(!reachable)(
      "route soft tags passed to get() are read the same way",
      async () => {
        await a.set("page", Promise.resolve(makeEntry({ tags: [], timestamp: Date.now() - 50 })));
        await b.updateTags(["_N_T_/blog"], { expire: 3600 });
        const got = await a.get("page", ["_N_T_/blog"]);
        expect(got).toBeDefined();
        expect(got!.revalidate).toBe(-1);
      }
    );

    it.skipIf(!reachable)(
      "the hard deadline of a soft invalidation is enforced on read",
      async () => {
        await a.set("page", Promise.resolve(makeEntry({ timestamp: Date.now() - 50 })));
        await b.updateTags(["posts"], { expire: 1 });
        await new Promise((r) => setTimeout(r, 1100));
        expect(await a.get("page", [])).toBeUndefined();
      }
    );

    it.skipIf(!reachable)(
      "getExpiration() reports B's hard deadline even though A holds an older soft one",
      async () => {
        await a.updateTags(["posts"], { expire: 3600 }); // A's mirror: soft, far deadline
        const before = Date.now();
        await b.updateTags(["posts"]); // hard
        const after = Date.now();
        const exp = await a.getExpiration(["posts"]);
        expect(exp).toBeGreaterThanOrEqual(before);
        expect(exp).toBeLessThanOrEqual(after);
      }
    );
  });
}
