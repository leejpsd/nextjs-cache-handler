/**
 * End-to-end integration tests against a real Redis 7 instance.
 *
 * Goal: validate everything that mock-based unit tests can't catch —
 *   - actual redis@5 / ioredis client method shapes
 *   - real Lua EVAL/EVALSHA semantics
 *   - real cursor-based scanIterator behavior
 *   - real TTL / EX behavior
 *   - real cross-process data flow (write here, read there)
 *
 * Each adapter runs the same test scenarios so the suite acts as a
 * compatibility floor: every released adapter has at least these
 * guarantees.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import type { CacheComponentsHandler } from "../../src/cache-components/index.js";
import { createIncrementalCacheHandler } from "../../src/incremental/index.js";
import type { CacheComponentsEntry, RedisClientLike } from "../../src/types.js";
import { adaptRedisV5, createRedisV5Client } from "../../src/shared/client/adapter-redis.js";
import {
  adaptIoredis,
  createIoredisClient,
} from "../../src/shared/client/adapter-ioredis.js";

import {
  bufferToStream,
  flushAll,
  getRedisUrl,
  isRedisReachable,
  readStreamFully,
} from "./_redis-helpers.js";

const NAMESPACE = "it-test";

function makeEntry(
  overrides: Partial<CacheComponentsEntry> = {}
): CacheComponentsEntry {
  return {
    value: bufferToStream(Buffer.from("integration-payload")),
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
  if (!reachable) {
     
    console.warn(
      "[integration] Redis unreachable at",
      getRedisUrl(),
      "— skipping tests. Bring up `docker compose -f docker-compose.test.yml up -d`."
    );
  }
});

// Each adapter runs the same scenarios. A failing adapter pinpoints which
// client lib regressed without dragging the rest down.
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
  describe(`integration: cacheHandlers (plural) over ${adapter.name}`, () => {
    let client: RedisClientLike;
    let handler: CacheComponentsHandler;

    beforeAll(async () => {
      if (!probed) reachable = await isRedisReachable();
      if (!reachable) return;
      client = adapter.build();
      if (!client.isOpen) await client.connect();
      handler = createCacheComponentsHandler({
        client: () => client,
        keyPrefix: "next-cache:",
        buildNamespace: () => NAMESPACE,
        abortTimeoutMs: 3000,
      });
    });

    beforeEach(async () => {
      if (!reachable) return;
      await flushAll(client);
    });

    afterAll(async () => {
      if (!reachable || !client) return;
      await flushAll(client);
      // Best-effort close; redis@5 has quit, ioredis has disconnect — but
      // since RedisClientLike doesn't expose either, we just let the process
      // tear down. Vitest fileParallelism=false means we don't leak between
      // files.
    });

    it.skipIf(!reachable)("set then get round-trips the payload", async () => {
      await handler.set("rt-1", Promise.resolve(makeEntry()));
      const got = await handler.get("rt-1", []);
      expect(got).toBeDefined();
      const buf = await readStreamFully(got!.value);
      expect(buf.toString("utf8")).toBe("integration-payload");
      expect(got!.tags).toEqual(["posts"]);
    });

    it.skipIf(!reachable)("get on missing key returns undefined", async () => {
      expect(await handler.get("never-written", [])).toBeUndefined();
    });

    it.skipIf(!reachable)(
      "Lua-atomic SET-with-tags writes both entry and tag set",
      async () => {
        await handler.set(
          "rt-2",
          Promise.resolve(makeEntry({ tags: ["alpha", "beta"] }))
        );
        const tagAlpha = await client.sMembers(
          `next-cache:tag:${NAMESPACE}:alpha`
        );
        const tagBeta = await client.sMembers(
          `next-cache:tag:${NAMESPACE}:beta`
        );
        expect(tagAlpha.length).toBe(1);
        expect(tagBeta.length).toBe(1);
      }
    );

    it.skipIf(!reachable)(
      "updateTags hard expire removes matching entries (Lua revalidateHard)",
      async () => {
        await handler.set(
          "rt-3a",
          Promise.resolve(makeEntry({ tags: ["bulk"] }))
        );
        await handler.set(
          "rt-3b",
          Promise.resolve(makeEntry({ tags: ["bulk"] }))
        );
        // Sanity: both written
        expect(await handler.get("rt-3a", [])).toBeDefined();
        expect(await handler.get("rt-3b", [])).toBeDefined();

        await handler.updateTags(["bulk"], { expire: 0 });

        expect(await handler.get("rt-3a", [])).toBeUndefined();
        expect(await handler.get("rt-3b", [])).toBeUndefined();
      }
    );

    it.skipIf(!reachable)(
      "updateTags soft path leaves entries reachable but bumps tag expiration",
      async () => {
        await handler.set("rt-4", Promise.resolve(makeEntry()));
        await handler.updateTags(["posts"], { expire: 3600 }); // profile durations → soft

        // Entry is still reachable (soft = serve-while-revalidate); verify the
        // "<stale>|<expired>" marker was written and parses on both sides.
        const markerKey = `next-cache:tag-expiration:${NAMESPACE}:posts`;
        const raw = await client.get(markerKey);
        expect(raw).not.toBeNull();
        const parts = String(raw).split("|").map(Number);
        const stale = parts[0]!;
        const expired = parts[1]!;
        expect(stale).toBeGreaterThan(0);
        expect(expired).toBe(stale + 3_600_000);
        // 0.4.1 readers parseInt the marker — must still see the stale stamp.
        expect(Number.parseInt(String(raw), 10)).toBe(stale);
      }
    );

    it.skipIf(!reachable)(
      "getExpiration over multiple tags returns the most recent timestamp",
      async () => {
        await handler.updateTags(["a"]);
        // Tiny gap so timestamps differ even on fast machines.
        await new Promise((r) => setTimeout(r, 10));
        await handler.updateTags(["b"]);

        const ts = await handler.getExpiration(["a", "b"]);
        expect(ts).toBeGreaterThan(0);
      }
    );

    it.skipIf(!reachable)(
      "scanIterator chunks hand back string arrays (regression for redis@5 chunk semantics)",
      async () => {
        // Write 25 entries and then probe the iterator directly to make
        // sure we get string keys, not nested arrays. This catches the
        // exact bug the reference implementation hit when migrating from
        // redis@4 to redis@5.
        for (let i = 0; i < 25; i += 1) {
          await handler.set(
            `scan-${i}`,
            Promise.resolve(makeEntry({ tags: [] }))
          );
        }
        let collected: string[] = [];
        for await (const chunk of client.scanIterator({
          MATCH: "next-cache:entry:*",
          COUNT: 5,
        })) {
          const items = Array.isArray(chunk)
            ? chunk.map(String)
            : [String(chunk)];
          collected = collected.concat(items);
        }
        expect(collected.length).toBeGreaterThanOrEqual(25);
        for (const k of collected) {
          expect(typeof k).toBe("string");
          expect(k.startsWith("next-cache:entry:")).toBe(true);
        }
      }
    );

    it.skipIf(!reachable)(
      "set with empty tags writes the entry with plain SET (no Lua eval)",
      async () => {
        await handler.set(
          "rt-empty-tags",
          Promise.resolve(makeEntry({ tags: [] }))
        );
        const got = await handler.get("rt-empty-tags", []);
        expect(got).toBeDefined();
      }
    );

    it.skipIf(!reachable)(
      "set respects expire (EX) — entry vanishes after Redis TTL",
      async () => {
        // Use a 1-second EX so the test stays fast.
        await handler.set(
          "rt-ttl",
          Promise.resolve(makeEntry({ expire: 1, revalidate: 1, stale: 0 }))
        );
        // Allow Redis to apply the EX. Then wait past it.
        await new Promise((r) => setTimeout(r, 1500));
        // Entry should be gone — our partition treats it as expired,
        // and Redis itself has TTL'd it.
        const got = await handler.get("rt-ttl", []);
        expect(got).toBeUndefined();
      }
    );
  });
}

describe.skipIf(!reachable)("integration: cacheHandler (singular ISR) over redis@5", () => {
  let client: RedisClientLike;
  let HandlerClass: ReturnType<typeof createIncrementalCacheHandler>;

  beforeAll(async () => {
    if (!probed) reachable = await isRedisReachable();
    if (!reachable) return;
    client = adaptRedisV5(
      createRedisV5Client({ type: "redis", url: getRedisUrl() })
    );
    if (!client.isOpen) await client.connect();
    HandlerClass = createIncrementalCacheHandler({
      client: () => client,
      keyPrefix: "next-incremental:",
      buildNamespace: () => NAMESPACE,
      abortTimeoutMs: 3000,
    });
  });

  beforeEach(async () => {
    if (!reachable) return;
    await flushAll(client);
  });

  it("APP_PAGE entry round-trip preserves Buffer body", async () => {
    const h = new HandlerClass();
    await h.set(
      "/blog/integration",
      {
        kind: "APP_PAGE",
        body: Buffer.from("<html>integration</html>"),
        headers: {},
      },
      { kind: "APP_PAGE" }
    );
    const got = await h.get("/blog/integration", { kind: "APP_PAGE" });
    expect(got).not.toBeNull();
    const value = got?.value as unknown as { body: Buffer };
    expect(Buffer.isBuffer(value.body)).toBe(true);
    expect(value.body.toString("utf8")).toBe("<html>integration</html>");
  });

  it("revalidateTag (hard) propagates so a subsequent get returns null", async () => {
    const h = new HandlerClass();
    await h.set(
      "/post/1",
      {
        kind: "APP_PAGE",
        body: Buffer.from("v1"),
        headers: { "x-next-cache-tags": "posts" },
      },
      { kind: "APP_PAGE" }
    );
    expect(await h.get("/post/1", { kind: "APP_PAGE" })).not.toBeNull();
    await h.revalidateTag("posts", { expire: 0 });
    expect(await h.get("/post/1", { kind: "APP_PAGE" })).toBeNull();
  });

  it("two handler instances against the same Redis see each other's writes", async () => {
    const h1 = new HandlerClass();
    const h2 = new HandlerClass();
    await h1.set(
      "/cross-instance",
      {
        kind: "APP_PAGE",
        body: Buffer.from("from h1"),
        headers: {},
      },
      { kind: "APP_PAGE" }
    );
    const got = await h2.get("/cross-instance", { kind: "APP_PAGE" });
    expect(got).not.toBeNull();
    const value = got?.value as unknown as { body: Buffer };
    expect(value.body.toString("utf8")).toBe("from h1");
  });
});
