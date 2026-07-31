/**
 * Adapter for `redis@5` (the official `node-redis` client).
 *
 * v5 already uses camelCase methods that match `RedisClientLike` almost
 * exactly, so this adapter is mostly a type assertion plus the
 * `createRedisV5Client` factory that codifies the "1.5s connectTimeout,
 * reconnectStrategy: false" defaults validated in production by the reference
 * implementation.
 */

import type { RedisClientType } from "redis";

import type { RedisClientConfig, RedisClientLike } from "../../types.js";
import { nodeRequire } from "../node-require.js";

export function adaptRedisV5(client: RedisClientType): RedisClientLike {
  return client as unknown as RedisClientLike;
}

export function createRedisV5Client(
  config: Extract<RedisClientConfig, { type: "redis" }>
): RedisClientType {
  // Lazy require so consumers using ioredis only don't pay the cost.
  // We do `require` instead of `await import` here because the parent
  // `buildClient` is already in an async context that handles awaiting.
   
  const { createClient } = nodeRequire("redis") as typeof import("redis");
  const useTls = config.tls ?? config.url.startsWith("rediss://");

  // redis@5 has a discriminated socket union (TCP / TLS / IPC) and disallows
  // explicit `undefined` under exactOptionalPropertyTypes. Build the options
  // object incrementally so optional fields stay absent when not set.
   
  const opts: any = {
    url: config.url,
    socket: {
      connectTimeout: config.connectTimeout ?? 1500,
      reconnectStrategy: false,
      ...(useTls ? { tls: true } : {}),
    },
  };
  if (config.password !== undefined) opts.password = config.password;

  return createClient(opts) as RedisClientType;
}
