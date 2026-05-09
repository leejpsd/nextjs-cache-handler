/**
 * Shared helpers for integration tests. Both adapters (redis@5, ioredis)
 * connect to the same Redis instance brought up by docker-compose.test.yml,
 * so the tests can FLUSHALL between runs and share a single port (6390).
 *
 * If the container isn't reachable, tests are skipped with a clear message
 * so a developer running `npm run test:integration` without docker doesn't
 * get a wall of confusing errors.
 */

import type { RedisClientLike } from "../../src/types.js";

const REDIS_URL =
  process.env.INTEGRATION_REDIS_URL || "redis://127.0.0.1:6390";

export function getRedisUrl(): string {
  return REDIS_URL;
}

/**
 * One-time reachability probe used by `beforeAll` hooks. If Redis isn't up,
 * the test file calls `it.skipIf(!reachable)` to skip cleanly.
 */
export async function isRedisReachable(): Promise<boolean> {
  try {
     
    const { createClient } = require("redis") as typeof import("redis");
    const c = createClient({
      url: REDIS_URL,
      socket: { connectTimeout: 1500, reconnectStrategy: false },
    });
    c.on("error", () => {
      /* swallow during probe */
    });
    await c.connect();
    await c.ping();
    await c.quit();
    return true;
  } catch {
    return false;
  }
}

/** Wipe the test database between scenarios. Tests own the keyspace. */
export async function flushAll(client: RedisClientLike): Promise<void> {
  // RedisClientLike doesn't expose flushAll on the public surface, so we
  // route through eval which all adapters implement.
  await client.eval("redis.call('FLUSHALL'); return 1", {
    keys: [],
    arguments: [],
  });
}

export async function readStreamFully(
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
     
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}
