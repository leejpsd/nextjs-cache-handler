import { afterEach, describe, expect, it } from "vitest";

import { createCacheComponentsHandler } from "../../src/cache-components/index.js";

const REDIS_URL =
  process.env.INTEGRATION_REDIS_URL || "redis://127.0.0.1:6390";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeHandler(type: "redis" | "ioredis", ns: string) {
  return createCacheComponentsHandler({
    client: { type, url: REDIS_URL },
    abortTimeoutMs: 1500,
    tagPubSub: true,
    buildNamespace: ns,
  });
}

for (const type of ["redis", "ioredis"] as const) {
  describe(`tagPubSub over real Redis (${type})`, () => {
    it("propagates an invalidation to a second instance in well under a second", async () => {
      const ns = `pubsub-${type}-${Math.floor(Math.random() * 1e9)}`;
      const a = makeHandler(type, ns);
      const b = makeHandler(type, ns);

      // Lazy subscription needs one gated op; give the SUBSCRIBE a moment.
      await b.get("warm", []);
      await new Promise((r) => setTimeout(r, 300));

      const before = Date.now();
      await a.updateTags([`t-${ns}`]); // soft — publishes

      // B must learn the timestamp WITHOUT ever calling refreshTags().
      let learned = 0;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        learned = await b.getExpiration([`t-${ns}`]);
        if (learned >= before) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const latency = Date.now() - before;
      expect(learned).toBeGreaterThanOrEqual(before);
      expect(latency).toBeLessThan(1000);
       
      console.log(`[tagPubSub:${type}] cross-instance propagation ${latency}ms`);
    });
  });
}
