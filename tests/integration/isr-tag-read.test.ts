/**
 * ISR handler tag reads (#34) against a real Redis: a page's tag states come
 * back with one MGET per get(), and a hard revalidateTag from a second
 * instance is still seen through that path. Runs over both adapters.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createIncrementalCacheHandler } from "../../src/incremental/index.js";
import type { RedisClientLike } from "../../src/types.js";
import { adaptRedisV5, createRedisV5Client } from "../../src/shared/client/adapter-redis.js";
import { adaptIoredis, createIoredisClient } from "../../src/shared/client/adapter-ioredis.js";

import { flushAll, getRedisUrl, isRedisReachable } from "./_redis-helpers.js";

const NAMESPACE = "it-isr-tag-read";

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

const page = (tags: string) => ({
  kind: "APP_PAGE" as const,
  body: Buffer.from("<html>isr</html>"),
  headers: { "x-next-cache-tags": tags },
});
const ctx = { kind: "APP_PAGE", cacheControl: { revalidate: 60 } };

for (const adapter of adapters) {
  describe(`integration: ISR tag reads over ${adapter.name}`, () => {
    let client: RedisClientLike;
    let Handler: ReturnType<typeof createIncrementalCacheHandler>;

    beforeAll(async () => {
      if (!probed) reachable = await isRedisReachable();
      if (!reachable) return;
      client = adapter.build();
      if (!client.isOpen) await client.connect();
      Handler = createIncrementalCacheHandler({
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

    afterAll(async () => {
      if (!reachable || !client) return;
      await flushAll(client);
    });

    it.skipIf(!reachable)("get() reads a page's tag states with one MGET", async () => {
      await new Handler().set("/blog", page("posts,authors,_N_T_/blog"), ctx);
      const mget = vi.spyOn(client, "mGet");
      const get = vi.spyOn(client, "get");

      expect(await new Handler().get("/blog", ctx)).not.toBeNull();

      expect(mget).toHaveBeenCalledTimes(1);
      expect(mget.mock.calls[0]![0]).toHaveLength(3);
      expect(get).toHaveBeenCalledTimes(1);
      mget.mockRestore();
      get.mockRestore();
    });

    it.skipIf(!reachable)(
      "a hard revalidateTag on instance B is seen by A through the MGET path",
      async () => {
        const a = new Handler();
        const b = new Handler();
        await a.set("/post/1", page("posts,authors"), ctx);
        expect(await a.get("/post/1", ctx)).not.toBeNull();

        await b.revalidateTag("authors");
        a.resetRequestCache();
        expect(await a.get("/post/1", ctx)).toBeNull();
      }
    );

    it.skipIf(!reachable)(
      "a soft revalidateTag on instance B backdates the entry read by A",
      async () => {
        const a = new Handler();
        const b = new Handler();
        await a.set("/post/2", page("posts,authors"), ctx);
        const before = (await a.get("/post/2", ctx))!.lastModified;

        await new Promise((r) => setTimeout(r, 20));
        await b.revalidateTag("posts", { expire: 3600 });
        a.resetRequestCache();
        const got = await a.get("/post/2", ctx);
        expect(got).not.toBeNull();
        expect(got!.lastModified).toBeLessThan(before);
      }
    );
  });
}
