/**
 * Adapter for `ioredis` (and `ioredis.Cluster`).
 *
 * ioredis uses snake_case method names (`sadd`, `smembers`, `mget`) and a
 * stream-based scan. We normalize both into the camelCase / async-iterable
 * `RedisClientLike` contract so the handlers don't need to know which client
 * is underneath.
 */

import type { Cluster, Redis } from "ioredis";

import type { RedisClientConfig, RedisClientLike } from "../../types.js";
import { nodeRequire } from "../node-require.js";

type AnyRedis = Redis | Cluster;

function adapt(client: AnyRedis, isClusterClient = false): RedisClientLike {
  return {
    get isOpen() {
      // ioredis exposes a `status` string. Both single-node and cluster
      // report "ready" once connected.
      return client.status === "ready";
    },
    connect: async () => {
      if (client.status !== "ready" && client.status !== "connecting") {
        await client.connect();
      }
    },
    get: (k) => client.get(k),
    set: (k, v, opts) => {
      const args: (string | number)[] = [];
      if (opts?.EX !== undefined) args.push("EX", opts.EX);
      if (opts?.NX) args.push("NX");
      return (client.set as (...a: unknown[]) => Promise<unknown>)(k, v, ...args);
    },
    del: async (keys) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      if (arr.length === 0) return 0;
      return client.del(...arr);
    },
    sAdd: async (k, m) => {
      const arr = Array.isArray(m) ? m : [m];
      if (arr.length === 0) return 0;
      return client.sadd(k, ...arr);
    },
    sMembers: (k) => client.smembers(k),
    expire: async (k, s) => {
      const r = await client.expire(k, s);
      return r;
    },
    mGet: async (keys) => {
      if (keys.length === 0) return [];
      return client.mget(...keys);
    },
    eval: (script, opts) =>
      client.eval(
        script,
        opts.keys.length,
        ...opts.keys,
        ...opts.arguments
      ) as Promise<unknown>,
    evalSha: (sha, opts) =>
      client.evalsha(
        sha,
        opts.keys.length,
        ...opts.keys,
        ...opts.arguments
      ) as Promise<unknown>,
    scriptLoad: async (script) =>
      (await client.script("LOAD", script)) as string,
    scanIterator: async function* ({ MATCH, COUNT }) {
      // Cluster does not support a single SCAN cursor across slots; use
      // ioredis's per-node iterator there. Single-node: standard SCAN cursor.
      if (isClusterClient) {
        const cluster = client as Cluster;
        for (const node of cluster.nodes("master")) {
          let cursor = "0";
          do {
            const [next, batch]: [string, string[]] = await node.scan(
              cursor,
              "MATCH",
              MATCH,
              "COUNT",
              COUNT ?? 100
            );
            cursor = next;
            if (batch.length > 0) yield batch;
          } while (cursor !== "0");
        }
      } else {
        const redis = client as Redis;
        let cursor = "0";
        do {
          const [next, batch]: [string, string[]] = await redis.scan(
            cursor,
            "MATCH",
            MATCH,
            "COUNT",
            COUNT ?? 100
          );
          cursor = next;
          if (batch.length > 0) yield batch;
        } while (cursor !== "0");
      }
    },
    ping: () => client.ping(),
    on: (event, listener) => {
      client.on(event, listener);
      return client;
    },
    dispose: () => {
      client.disconnect();
    },
  };
}

export function adaptIoredis(client: Redis): RedisClientLike {
  return adapt(client, false);
}

export function adaptCluster(cluster: Cluster): RedisClientLike {
  return adapt(cluster, true);
}

export function createIoredisClient(
  config: Extract<RedisClientConfig, { type: "ioredis" }>
): Redis {
   
  const IORedis = nodeRequire("ioredis") as typeof import("ioredis");
  // ioredis exports the class as both `default` and a named property.
  // Hitting the default works for both ESM and CJS consumers.
  const Ctor = IORedis.default ?? (IORedis as unknown as typeof import("ioredis").default);
  return new Ctor(config.url, {
    password: config.password,
    connectTimeout: config.connectTimeout ?? 1500,
    tls: config.tls ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    // Batch same-tick commands into one RTT (matches redis@5's default
    // behavior) — makes Promise.all fan-outs a single pipeline.
    enableAutoPipelining: true,
  });
}

export function createIoredisSentinel(
  config: Extract<RedisClientConfig, { type: "sentinel" }>
): Redis {
  const IORedis = nodeRequire("ioredis") as typeof import("ioredis");
  const Ctor = IORedis.default ?? (IORedis as unknown as typeof import("ioredis").default);
  return new Ctor({
    sentinels: config.sentinels,
    name: config.name,
    password: config.password,
    sentinelPassword: config.sentinelPassword,
    connectTimeout: config.connectTimeout ?? 1500,
    tls: config.tls ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableAutoPipelining: true,
  });
}

export function createIoredisCluster(
  config: Extract<RedisClientConfig, { type: "cluster" }>
): Cluster {
   
  const IORedis = nodeRequire("ioredis") as typeof import("ioredis");
  const ClusterCtor =
    IORedis.Cluster ??
    (IORedis.default as unknown as { Cluster: typeof import("ioredis").Cluster })
      .Cluster;
  return new ClusterCtor(config.nodes, {
    redisOptions: {
      password: config.password,
      tls: config.tls ? {} : undefined,
    },
    enableReadyCheck: true,
    lazyConnect: true,
    // Same-slot commands issued in the same tick share one pipeline.
    enableAutoPipelining: true,
  });
}
