/**
 * Client factory. Resolves a `RedisClientFactory | RedisClientConfig` to a
 * connected `RedisClientLike`, with idempotent connect.
 *
 * The factory caches the resolved client per-handler so repeated calls don't
 * spawn parallel connections. Adapter modules (`adapter-redis`,
 * `adapter-ioredis`) are lazy-imported so peer-deps you don't use stay out of
 * your bundle.
 */

import type {
  RedisClientFactory,
  RedisClientConfig,
  RedisClientLike,
} from "../../types.js";

export async function buildClient(
  source: RedisClientFactory | RedisClientConfig
): Promise<RedisClientLike> {
  if (typeof source === "function") {
    return await source();
  }
  switch (source.type) {
    case "redis": {
      const { adaptRedisV5, createRedisV5Client } = await import(
        "./adapter-redis.js"
      );
      return adaptRedisV5(createRedisV5Client(source));
    }
    case "ioredis": {
      const { adaptIoredis, createIoredisClient } = await import(
        "./adapter-ioredis.js"
      );
      return adaptIoredis(createIoredisClient(source));
    }
    case "cluster": {
      const { adaptCluster, createIoredisCluster } = await import(
        "./adapter-ioredis.js"
      );
      return adaptCluster(createIoredisCluster(source));
    }
    default: {
      const exhaustive: never = source;
      throw new Error(
        `[next-cache] unknown client config: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}

/**
 * Manage connect state without launching parallel connect calls. The reference
 * implementation's `connectPromise` pattern is preserved here.
 */
export class ConnectionManager {
  private client: RedisClientLike | null = null;
  private connecting: Promise<RedisClientLike | null> | null = null;
  private failed = false;

  constructor(
    private readonly source: RedisClientFactory | RedisClientConfig,
    private readonly onError: (err: Error) => void
  ) {}

  async getOrConnect(): Promise<RedisClientLike | null> {
    if (this.client?.isOpen) return this.client;
    if (this.failed) return null;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const c = await buildClient(this.source);
        c.on("error", (err) => this.onError(err));
        if (!c.isOpen) await c.connect();
        this.client = c;
        return c;
      } catch (err) {
        this.failed = true;
        this.onError(err as Error);
        return null;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  reset(): void {
    this.client = null;
    this.connecting = null;
    this.failed = false;
  }
}
