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
    case "sentinel": {
      const { adaptIoredis, createIoredisSentinel } = await import(
        "./adapter-ioredis.js"
      );
      return adaptIoredis(createIoredisSentinel(source));
    }
    default: {
      const exhaustive: never = source;
      throw new Error(
        `[next-cache] unknown client config: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}

export interface ConnectionRetryOptions {
  /** Cooldown before the first retry after a failed connect (ms). Default 1000. */
  baseCooldownMs?: number;
  /** Upper bound for the exponential cooldown (ms). Default 30000. */
  maxCooldownMs?: number;
}

/**
 * Manage connect state without launching parallel connect calls. The reference
 * implementation's `connectPromise` pattern is preserved here.
 *
 * A failed connect does NOT latch the manager into a dead state: retries are
 * allowed after an exponential cooldown (base 1s, doubling per consecutive
 * failure, capped at 30s). During the cooldown `getOrConnect()` returns `null`
 * immediately so request paths fast-fail to the memory fallback instead of
 * queueing behind doomed connect attempts. A dropped connection (client
 * present but no longer open) is replaced with a fresh client on the next
 * call; the dead client is disposed best-effort.
 */
export class ConnectionManager {
  private client: RedisClientLike | null = null;
  private connecting: Promise<RedisClientLike | null> | null = null;
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(
    private readonly source: RedisClientFactory | RedisClientConfig,
    private readonly onError: (err: Error) => void,
    retry: ConnectionRetryOptions = {}
  ) {
    this.baseCooldownMs = retry.baseCooldownMs ?? 1000;
    this.maxCooldownMs = retry.maxCooldownMs ?? 30_000;
  }

  private cooldownMs(): number {
    if (this.consecutiveFailures === 0) return 0;
    return Math.min(
      this.maxCooldownMs,
      this.baseCooldownMs * 2 ** (this.consecutiveFailures - 1)
    );
  }

  async getOrConnect(): Promise<RedisClientLike | null> {
    if (this.client?.isOpen) return this.client;
    if (this.connecting) return this.connecting;
    if (Date.now() - this.lastFailureAt < this.cooldownMs()) return null;

    const stale = this.client;
    this.client = null;

    this.connecting = (async () => {
      disposeQuietly(stale);
      try {
        const c = await buildClient(this.source);
        c.on("error", (err) => this.onError(err));
        if (!c.isOpen) await c.connect();
        this.client = c;
        this.consecutiveFailures = 0;
        return c;
      } catch (err) {
        this.consecutiveFailures += 1;
        this.lastFailureAt = Date.now();
        this.onError(err as Error);
        return null;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  reset(): void {
    disposeQuietly(this.client);
    this.client = null;
    this.connecting = null;
    this.consecutiveFailures = 0;
    this.lastFailureAt = 0;
  }
}

/**
 * Close a replaced client so it stops reconnect loops and frees its socket.
 * The adapters expose `dispose`; raw clients passed via a factory may expose
 * `destroy` (redis@5) or `disconnect` (ioredis) instead.
 */
function disposeQuietly(client: RedisClientLike | null): void {
  if (!client) return;
  const c = client as RedisClientLike & {
    destroy?: () => unknown;
    disconnect?: () => unknown;
  };
  try {
    (c.dispose ?? c.destroy ?? c.disconnect)?.call(c);
  } catch {
    // Best-effort: a client that fails to close is abandoned to GC.
  }
}
